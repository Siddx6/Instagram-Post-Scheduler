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
const isProduction = process.env.NODE_ENV === "production";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Initialize database
await initDB();

// --------------------
// CORE MIDDLEWARE
// --------------------
const allowedOrigins = isProduction
  ? [process.env.PRODUCTION_URL, process.env.FB_REDIRECT_URI]
  : ["http://localhost:3000", "http://127.0.0.1:3000"];

app.use(
  cors({
    origin: (origin, callback) => {
      // Allow requests with no origin (like mobile apps or curl)
      if (!origin) return callback(null, true);
      if (allowedOrigins.some(allowed => origin.startsWith(allowed))) {
        callback(null, true);
      } else {
        callback(new Error("Not allowed by CORS"));
      }
    },
    credentials: true,
  })
);

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// --------------------
// SESSION
// --------------------
app.use(
  session({
    secret: process.env.SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: {
      secure: isProduction,
      httpOnly: true,
      maxAge: 30 * 24 * 60 * 60 * 1000, // 30 days
      sameSite: isProduction ? "none" : "lax",
    },
  })
);

// --------------------
// AUTH ROUTES
// --------------------
app.use("/auth", authRouter);

// --------------------
// AUTH MIDDLEWARE
// --------------------
function requireAuth(req, res, next) {
  if (!req.session.userId) {
    return res.status(401).json({ error: "Not authenticated" });
  }
  next();
}

// --------------------
// API ROUTES
// --------------------
app.get("/api/auth/status", (req, res) => {
  if (req.session.userId) {
    res.json({ 
      authenticated: true, 
      userName: req.session.userName,
      userId: req.session.userId 
    });
  } else {
    res.json({ authenticated: false });
  }
});

app.post("/api/auth/logout", (req, res) => {
  req.session.destroy((err) => {
    if (err) {
      return res.status(500).json({ error: "Logout failed" });
    }
    res.json({ success: true });
  });
});

app.get("/api/accounts", requireAuth, async (req, res) => {
  try {
    const user = await db.get(
      "SELECT * FROM users WHERE id = ?",
      [req.session.userId]
    );

    if (!user || !user.user_token) {
      return res.status(401).json({ error: "No valid token found. Please re-authenticate." });
    }

    // Check if token is expired
    if (user.user_token_expires_at) {
      const expiresAt = new Date(user.user_token_expires_at);
      if (expiresAt <= new Date()) {
        return res.status(401).json({ error: "Token expired. Please re-authenticate." });
      }
    }

    // Fetch Facebook pages with Instagram accounts
    const pagesRes = await axios.get(
      `https://graph.facebook.com/${FB_VERSION}/me/accounts`,
      {
        params: {
          fields: "id,name,instagram_business_account{id,username},access_token",
          access_token: user.user_token,
        },
      }
    );

    const pagesData = pagesRes.data.data || [];
    
    // Filter pages that have Instagram accounts
    const accounts = pagesData
      .filter((p) => p.instagram_business_account)
      .map((p) => ({
        ig_user_id: p.instagram_business_account.id,
        page_id: p.id,
        page_name: p.name,
        ig_username: p.instagram_business_account.username,
      }));

    // Store/update accounts in database
    for (const page of pagesData) {
      if (page.instagram_business_account) {
        const existing = await db.get(
          "SELECT * FROM ig_accounts WHERE page_id = ? AND user_id = ?",
          [page.id, user.id]
        );

        if (!existing) {
          await db.run(
            `INSERT INTO ig_accounts 
             (user_id, page_id, page_name, page_access_token, ig_user_id)
             VALUES (?, ?, ?, ?, ?)`,
            [
              user.id,
              page.id,
              page.name,
              page.access_token,
              page.instagram_business_account.id,
            ]
          );
        } else {
          await db.run(
            `UPDATE ig_accounts 
             SET page_access_token = ?, page_name = ?, ig_user_id = ?
             WHERE id = ?`,
            [
              page.access_token,
              page.name,
              page.instagram_business_account.id,
              existing.id,
            ]
          );
        }
      }
    }

    res.json(accounts);
  } catch (err) {
    console.error("Get accounts error:", err.response?.data || err.message);
    
    if (err.response?.data?.error?.code === 190) {
      return res.status(401).json({ 
        error: "Invalid or expired token. Please re-authenticate.",
        code: "TOKEN_INVALID"
      });
    }
    
    res.status(500).json({ error: "Failed to fetch accounts" });
  }
});

app.post("/api/schedule", requireAuth, async (req, res) => {
  const { ig_user_id, caption, media_url, scheduled_time } = req.body;

  if (!ig_user_id || !caption || !media_url || !scheduled_time) {
    return res.status(400).json({ error: "Missing required fields" });
  }

  // Validate scheduled time is in the future
  const scheduledDate = new Date(scheduled_time);
  if (scheduledDate <= new Date()) {
    return res.status(400).json({ error: "Scheduled time must be in the future" });
  }

  try {
    const igAccount = await db.get(
      "SELECT * FROM ig_accounts WHERE ig_user_id = ? AND user_id = ?",
      [ig_user_id, req.session.userId]
    );

    if (!igAccount) {
      return res.status(404).json({ error: "Instagram account not found" });
    }

    // Validate media URL
    if (!media_url.match(/^https?:\/\/.+\.(jpg|jpeg|png|gif)$/i)) {
      return res.status(400).json({ error: "Invalid image URL format" });
    }

    const result = await db.run(
      `INSERT INTO posts 
       (user_id, ig_account_id, caption, media_url, scheduled_time, status)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [
        req.session.userId,
        igAccount.id,
        caption,
        media_url,
        scheduled_time,
        "pending",
      ]
    );

    res.json({ 
      success: true, 
      postId: result.lastID,
      message: "Post scheduled successfully" 
    });
  } catch (err) {
    console.error("Schedule error:", err);
    res.status(500).json({ error: "Failed to schedule post" });
  }
});

app.get("/api/posts", requireAuth, async (req, res) => {
  try {
    const rows = await db.all(
      `SELECT p.*, ia.page_name, ia.ig_user_id 
       FROM posts p
       JOIN ig_accounts ia ON p.ig_account_id = ia.id
       WHERE p.user_id = ?
       ORDER BY p.scheduled_time DESC`,
      [req.session.userId]
    );
    res.json(rows);
  } catch (err) {
    console.error("Fetch posts error:", err);
    res.status(500).json({ error: "Failed to fetch posts" });
  }
});

app.delete("/api/posts/:id", requireAuth, async (req, res) => {
  try {
    const post = await db.get(
      "SELECT * FROM posts WHERE id = ? AND user_id = ?",
      [req.params.id, req.session.userId]
    );

    if (!post) {
      return res.status(404).json({ error: "Post not found" });
    }

    if (post.status === "published") {
      return res.status(400).json({ error: "Cannot delete published posts" });
    }

    await db.run(
      "DELETE FROM posts WHERE id = ?",
      [req.params.id]
    );

    res.json({ success: true, message: "Post deleted" });
  } catch (err) {
    console.error("Delete post error:", err);
    res.status(500).json({ error: "Failed to delete post" });
  }
});

// --------------------
// HEALTH CHECK
// --------------------
app.get("/health", (req, res) => {
  res.json({ 
    status: "ok", 
    timestamp: new Date().toISOString(),
    environment: process.env.NODE_ENV 
  });
});

// --------------------
// STATIC FILES
// --------------------
app.use(express.static(path.join(__dirname, "public")));

app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "public/index.html"));
});

// --------------------
// CRON JOB - Post Publisher
// --------------------
cron.schedule("* * * * *", async () => {
  try {
    const now = new Date().toISOString();

    const posts = await db.all(
      `SELECT p.*, ia.page_access_token, ia.ig_user_id 
       FROM posts p
       JOIN ig_accounts ia ON p.ig_account_id = ia.id
       WHERE p.scheduled_time <= ? AND p.status = 'pending'`,
      [now]
    );

    console.log(`📅 Checking scheduled posts... Found: ${posts.length}`);

    for (const post of posts) {
      try {
        console.log(`📤 Publishing post ID ${post.id}...`);

        // Step 1: Create media container
        const mediaRes = await axios.post(
          `https://graph.facebook.com/${FB_VERSION}/${post.ig_user_id}/media`,
          null,
          {
            params: {
              image_url: post.media_url,
              caption: post.caption,
              access_token: post.page_access_token,
            },
          }
        );

        const creationId = mediaRes.data.id;
        console.log(`✅ Media container created: ${creationId}`);

        // Step 2: Publish the media
        const publishRes = await axios.post(
          `https://graph.facebook.com/${FB_VERSION}/${post.ig_user_id}/media_publish`,
          null,
          {
            params: {
              creation_id: creationId,
              access_token: post.page_access_token,
            },
          }
        );

        await db.run(
          "UPDATE posts SET status = 'published', posted_at = ? WHERE id = ?",
          [new Date().toISOString(), post.id]
        );

        console.log(`✅ Post ${post.id} published successfully: ${publishRes.data.id}`);
      } catch (err) {
        const errorMsg = err.response?.data?.error?.message || err.message;
        console.error(`❌ Failed to publish post ${post.id}:`, errorMsg);

        await db.run(
          "UPDATE posts SET status = 'failed', error_message = ? WHERE id = ?",
          [errorMsg, post.id]
        );
      }
    }
  } catch (err) {
    console.error("Cron job error:", err);
  }
});

// --------------------
// ERROR HANDLER
// --------------------
app.use((err, req, res, next) => {
  console.error("Express error:", err);
  res.status(500).json({ error: "Internal server error" });
});

// --------------------
// START SERVER
// --------------------
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
  console.log(`📝 Environment: ${process.env.NODE_ENV}`);
  console.log(`🔗 Redirect URI: ${process.env.FB_REDIRECT_URI}`);
});