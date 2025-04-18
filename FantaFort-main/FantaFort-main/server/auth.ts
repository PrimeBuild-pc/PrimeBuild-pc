import passport from "passport";
import { Strategy as LocalStrategy } from "passport-local";
import { Express } from "express";
import session from "express-session";
import { scrypt, randomBytes, timingSafeEqual } from "crypto";
import { promisify } from "util";
import { storage } from "./storage";
import { supabaseStorage } from "./supabase-storage";
import { SupabaseDatabaseStorage } from "./supabase-db-storage";
import { User as SelectUser } from "@shared/schema";

declare global {
  namespace Express {
    interface User extends SelectUser {}
  }
}

const scryptAsync = promisify(scrypt);

async function hashPassword(password: string) {
  const salt = randomBytes(16).toString("hex");
  const buf = (await scryptAsync(password, salt, 64)) as Buffer;
  return `${buf.toString("hex")}.${salt}`;
}

async function comparePasswords(supplied: string, stored: string) {
  const [hashed, salt] = stored.split(".");
  const hashedBuf = Buffer.from(hashed, "hex");
  const suppliedBuf = (await scryptAsync(supplied, salt, 64)) as Buffer;
  return timingSafeEqual(hashedBuf, suppliedBuf);
}

export function setupAuth(app: Express) {
  // Create a database storage instance for session store
  const dbStorage = new SupabaseDatabaseStorage();

  // Session settings with secure configuration
  const sessionSettings: session.SessionOptions = {
    secret: process.env.SESSION_SECRET || "fortnite-fantasy-session-secret-key",
    resave: false,
    saveUninitialized: false,
    store: dbStorage.sessionStore, // Use Supabase session store
    cookie: {
      maxAge: 24 * 60 * 60 * 1000, // 24 hours
      secure: process.env.NODE_ENV === "production",
      httpOnly: true, // Prevents JavaScript from reading the cookie
      sameSite: "lax" // Provides CSRF protection
    },
  };

  app.set("trust proxy", 1);
  app.use(session(sessionSettings));
  app.use(passport.initialize());
  app.use(passport.session());

  passport.use(
    new LocalStrategy(async (username, password, done) => {
      try {
        // Try Supabase database storage
        let user = await dbStorage.getUserByUsername(username);

        // Fall back to regular storage if user not found in Supabase
        if (!user) {
          user = await storage.getUserByUsername(username);
        }

        if (!user) {
          return done(null, false, { message: "Incorrect username" });
        }

        // First try secure password comparison
        if (await comparePasswords(password, user.password)) {
          return done(null, user);
        }

        // Fallback to direct comparison for development (if password isn't hashed)
        if (user.password === password) {
          return done(null, user);
        }

        return done(null, false, { message: "Incorrect password" });
      } catch (error) {
        console.error('Authentication error:', error);
        return done(error);
      }
    }),
  );

  passport.serializeUser((user, done) => done(null, user.id));

  passport.deserializeUser(async (id: number, done) => {
    try {
      // Try Supabase database storage
      let user = await dbStorage.getUserById(id);

      // Fall back to regular storage if user not found in Supabase
      if (!user) {
        user = await storage.getUser(id);
      }

      if (!user) {
        return done(null, false);
      }

      done(null, user);
    } catch (error) {
      console.error('Deserialize user error:', error);
      done(error);
    }
  });

  app.post("/api/register", async (req, res, next) => {
    try {
      // Check if user exists in either storage
      let existingUser = await dbStorage.getUserByUsername(req.body.username);
      if (!existingUser) {
        existingUser = await storage.getUserByUsername(req.body.username);
      }

      if (existingUser) {
        return res.status(400).json({ error: "Username already exists" });
      }

      // Hash the password for security
      const hashedPassword = await hashPassword(req.body.password);

      // Create user in Supabase database storage
      const user = await dbStorage.createUser({
        username: req.body.username,
        password: hashedPassword,
        email: req.body.email || null,
        coins: 1000, // Default starting coins
        teamId: null,
        avatar: null,
        isPublicProfile: false
      });

      req.login(user, (err) => {
        if (err) return next(err);
        res.status(201).json({
          id: user.id,
          username: user.username,
        });
      });
    } catch (error) {
      console.error("Registration error:", error);
      next(error);
    }
  });

  app.post("/api/login", passport.authenticate("local"), (req, res) => {
    const user = req.user as SelectUser;
    res.status(200).json({
      id: user.id,
      username: user.username,
    });
  });

  app.post("/api/logout", (req, res, next) => {
    req.logout((err) => {
      if (err) return next(err);
      res.sendStatus(200);
    });
  });

  app.get("/api/user", (req, res) => {
    if (!req.isAuthenticated()) {
      return res.status(401).json({ error: "Not authenticated" });
    }

    const user = req.user as SelectUser;

    // Return a safe user object without the password
    res.json({
      id: user.id,
      username: user.username,
      coins: user.coins || 1000, // Default coins if not set
      teamId: user.teamId,
      // Optionally include other non-sensitive fields
      avatar: user.avatar,
      email: user.email,
      isPublicProfile: user.isPublicProfile
    });
  });
}