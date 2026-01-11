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

// Initialize database
await initDB();

// Middleware
app.use(cors({
  origin: process.env.NODE_ENV === 'production' 
    ? process.env.PRODUCTION_URL 
    : 'http://localhost:3000',
  credentials: true
}));
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));
app.use(
  session({
    secret: process.env.SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: {
      secure: process.env.NODE_ENV === 'production',
      httpOnly: true,
      maxAge: 24 * 60 * 60 * 1000 // 24 hours
    }
  })
);

// Auth routes
app.use('/auth', authRouter);

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

    // Save/update accounts in database
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

// Schedule post
app.post("/api/schedule", requireAuth, async (req, res) => {
  const { ig_user_id, caption, media_url, scheduled_time } = req.body;

  if (!ig_user_id || !caption || !media_url || !scheduled_time) {
    return res.status(400).json({ error: "Missing required fields" });
  }

  try {
    // Get the ig_account record for this user
    const igAccount = await db.get(
      "SELECT * FROM ig_accounts WHERE ig_user_id = ? AND user_id = ?",
      [ig_user_id, req.session.userId]
    );

    if (!igAccount) {
      return res.status(404).json({ error: "Instagram account not found or not authorized" });
    }

    await db.run(
      `INSERT INTO posts (user_id, ig_account_id, caption, media_url, scheduled_time, status)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [req.session.userId, igAccount.id, caption, media_url, scheduled_time, "pending"]
    );

    res.json({ success: true });
  } catch (err) {
    console.error("Schedule error:", err);
    res.status(500).json({ error: "Failed to schedule post" });
  }
});

// Fetch scheduled posts (only for current user)
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

// Delete post
app.delete("/api/posts/:id", requireAuth, async (req, res) => {
  try {
    await db.run(
      "DELETE FROM posts WHERE id = ? AND user_id = ?",
      [req.params.id, req.session.userId]
    );
    res.json({ success: true });
  } catch (err) {
    console.error("Delete error:", err);
    res.status(500).json({ error: "Failed to delete post" });
  }
});

// Manual test publish endpoint
app.post("/api/test-publish/:id", requireAuth, async (req, res) => {
  try {
    const post = await db.get(
      `SELECT p.*, ia.page_access_token, ia.ig_user_id 
       FROM posts p
       JOIN ig_accounts ia ON p.ig_account_id = ia.id
       WHERE p.id = ? AND p.user_id = ?`,
      [req.params.id, req.session.userId]
    );

    if (!post) return res.status(404).json({ error: "Post not found" });

    console.log(`📤 Attempting to publish post ${post.id}...`);

    // Create media container
    const mediaRes = await axios.post(
      `https://graph.facebook.com/${FB_VERSION}/${post.ig_user_id}/media`,
      {
        image_url: post.media_url,
        caption: post.caption,
        access_token: post.page_access_token,
      }
    );

    const creationId = mediaRes.data.id;
    console.log(`📦 Media container created: ${creationId}`);

    // Publish media
    const publishRes = await axios.post(
      `https://graph.facebook.com/${FB_VERSION}/${post.ig_user_id}/media_publish`,
      {
        creation_id: creationId,
        access_token: post.page_access_token,
      }
    );

    await db.run(
      "UPDATE posts SET status = 'published', posted_at = ? WHERE id = ?",
      [new Date().toISOString(), post.id]
    );

    console.log(`✅ Post ${post.id} published successfully! IG ID: ${publishRes.data.id}`);
    res.json({ success: true, instagram_id: publishRes.data.id });
  } catch (err) {
    console.error("Manual publish error:", err.response?.data || err);
    const errorMsg = err.response?.data?.error?.message || err.message;
    
    await db.run(
      "UPDATE posts SET status = 'failed', error_message = ? WHERE id = ?",
      [errorMsg, req.params.id]
    );

    res.status(500).json({ 
      error: errorMsg,
      details: err.response?.data
    });
  }
});

// Debug time endpoint
app.get("/api/debug/time", (req, res) => {
  res.json({
    server_time_iso: new Date().toISOString(),
    server_time_readable: new Date().toString(),
    server_timezone: Intl.DateTimeFormat().resolvedOptions().timeZone
  });
});

// Serve UI
app.get("/", (req, res) => res.sendFile(path.join(__dirname, "public/index.html")));

// Scheduler - runs every minute
cron.schedule('* * * * *', async () => {
  const now = new Date().toISOString();
  console.log(`🔍 Scheduler running at ${now}`);

  try {
    const posts = await db.all(
      `SELECT p.*, ia.page_access_token, ia.ig_user_id 
       FROM posts p
       JOIN ig_accounts ia ON p.ig_account_id = ia.id
       WHERE p.scheduled_time <= ? AND p.status = 'pending'`,
      [now]
    );

    console.log(`📋 Found ${posts.length} post(s) to process`);

    if (!posts.length) return;

    for (const post of posts) {
      if (!post.ig_user_id || !post.page_access_token) {
        console.log(`⚠️ Post ${post.id} missing credentials, marking as failed`);
        await db.run(
          "UPDATE posts SET status = 'failed', error_message = ? WHERE id = ?",
          ["Missing access token or Instagram account", post.id]
        );
        continue;
      }

      try {
        console.log(`📤 Publishing post ${post.id}...`);

        // Create media container
        const mediaRes = await axios.post(
          `https://graph.facebook.com/${FB_VERSION}/${post.ig_user_id}/media`,
          {
            image_url: post.media_url,
            caption: post.caption,
            access_token: post.page_access_token,
          }
        );

        const creationId = mediaRes.data.id;
        if (!creationId) throw new Error("No media ID returned from Instagram");

        console.log(`📦 Media container created: ${creationId}`);

        // Publish media
        const publishRes = await axios.post(
          `https://graph.facebook.com/${FB_VERSION}/${post.ig_user_id}/media_publish`,
          {
            creation_id: creationId,
            access_token: post.page_access_token,
          }
        );

        await db.run(
          "UPDATE posts SET status = 'published', posted_at = ? WHERE id = ?",
          [new Date().toISOString(), post.id]
        );

        console.log(`✅ Post ${post.id} published successfully! IG ID: ${publishRes.data.id}`);

      } catch (err) {
        const errorMsg = err.response?.data?.error?.message || err.message;
        console.error(`❌ Post ${post.id} failed:`, errorMsg);
        
        await db.run(
          "UPDATE posts SET status = 'failed', error_message = ? WHERE id = ?",
          [errorMsg, post.id]
        );
      }
    }
  } catch (err) {
    console.error("❌ Scheduler error:", err.message);
  }
});

app.listen(PORT, () => {
  console.log(`🚀 Server running at http://localhost:${PORT}`);
  console.log(`⏰ Scheduler is active and checking every minute`);
});
