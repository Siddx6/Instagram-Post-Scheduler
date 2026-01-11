import express from "express";
import session from "express-session";
import dotenv from "dotenv";
import cors from "cors";
import path from "path";
import { fileURLToPath } from "url";
import { initDB, db } from "./db.js";
import authRouter from "./auth.js";
import cron from "node-cron";
import axios from "axios";

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;
const FB_VERSION = process.env.FB_GRAPH_VERSION || "v21.0";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// 🔴 REQUIRED FOR RENDER (HTTPS + PROXY)
app.set("trust proxy", 1);

// Initialize database
await initDB();

// Middleware
app.use(cors({
  origin: [
    "https://instagram-post-scheduler.onrender.com",
    "http://localhost:3000"
  ],
  credentials: true
}));


app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

// ✅ FIXED SESSION CONFIG (DO NOT CHANGE)
app.use(
  session({
    name: "ig-scheduler.sid",
    secret: process.env.SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: {
      secure: process.env.NODE_ENV === "production", // HTTPS only on Render
      httpOnly: true,
      sameSite: "lax", // 🔴 REQUIRED FOR FACEBOOK OAUTH
      maxAge: 24 * 60 * 60 * 1000
    }
  })
);

// Auth routes
app.use("/auth", authRouter);

// Auth middleware
function requireAuth(req, res, next) {
  if (!req.session.userId) {
    return res.status(401).json({ error: "Not authenticated" });
  }
  next();
}

// Check auth status
app.get("/api/auth/status", (req, res) => {
  if (req.session.userId) {
    res.json({ authenticated: true, userName: req.session.userName });
  } else {
    res.json({ authenticated: false });
  }
});

// Logout
app.post("/api/auth/logout", (req, res) => {
  req.session.destroy();
  res.json({ success: true });
});

// Get connected accounts
app.get("/api/accounts", requireAuth, async (req, res) => {
  try {
    const user = await db.get("SELECT * FROM users WHERE id = ?", [req.session.userId]);
    if (!user || !user.user_token) {
      return res.status(401).json({ error: "No valid token" });
    }

    const pagesRes = await axios.get(`https://graph.facebook.com/${FB_VERSION}/me/accounts`, {
      params: {
        fields: "id,name,instagram_business_account{id,username},access_token",
        access_token: user.user_token,
      },
    });

    const accounts = (pagesRes.data.data || [])
      .filter(p => p.instagram_business_account)
      .map(p => ({
        ig_user_id: p.instagram_business_account.id,
        page_id: p.id,
        page_name: p.name,
        ig_username: p.instagram_business_account.username,
      }));

    for (const account of pagesRes.data.data) {
      if (account.instagram_business_account) {
        const existing = await db.get(
          "SELECT * FROM ig_accounts WHERE page_id = ? AND user_id = ?",
          [account.id, user.id]
        );

        if (!existing) {
          await db.run(
            "INSERT INTO ig_accounts (user_id, page_id, page_name, page_access_token, ig_user_id) VALUES (?, ?, ?, ?, ?)",
            [user.id, account.id, account.name, account.access_token, account.instagram_business_account.id]
          );
        } else {
          await db.run(
            "UPDATE ig_accounts SET page_access_token = ?, page_name = ?, ig_user_id = ? WHERE id = ?",
            [account.access_token, account.name, account.instagram_business_account.id, existing.id]
          );
        }
      }
    }

    res.json(accounts);
  } catch (err) {
    console.error("Get accounts error:", err.response?.data || err.message);
    res.status(500).json({ error: "Failed to fetch accounts" });
  }
});

// Serve UI
app.get("/", (req, res) =>
  res.sendFile(path.join(__dirname, "public/index.html"))
);

// Scheduler + rest of your file remains unchanged
// (No logic changes needed)

app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});
