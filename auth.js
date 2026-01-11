import express from "express";
import crypto from "crypto";
import axios from "axios";
import { db } from "./db.js";

const router = express.Router();

const FB_APP_ID = process.env.FB_APP_ID;
const FB_APP_SECRET = process.env.FB_APP_SECRET;
const FB_REDIRECT_URI = process.env.FB_REDIRECT_URI;
const FB_VERSION = process.env.FB_GRAPH_VERSION || "v21.0";

/**
 * STEP 1: Start OAuth
 */
router.get("/facebook", (req, res) => {
  if (!req.session) {
    return res.status(500).send("Session not initialized");
  }

  const state = crypto.randomBytes(16).toString("hex");
  req.session.oauthState = state;

  const params = new URLSearchParams({
    client_id: FB_APP_ID,
    redirect_uri: FB_REDIRECT_URI,
    state,
    scope: "pages_show_list,instagram_basic,instagram_content_publish,pages_read_engagement,business_management",
    response_type: "code",
  });

  res.redirect(
    `https://www.facebook.com/${FB_VERSION}/dialog/oauth?${params.toString()}`
  );
});

/**
 * STEP 2: OAuth Callback - Exchange code for tokens
 */
router.get("/facebook/callback", async (req, res) => {
  const { code, state, error, error_description } = req.query;

  // Handle OAuth errors
  if (error) {
    console.error("OAuth error:", error, error_description);
    return res.redirect(`/?error=${encodeURIComponent(error_description || error)}`);
  }

  if (!code) {
    return res.redirect("/?error=missing_code");
  }

  // Validate state
  if (!req.session || state !== req.session.oauthState) {
    console.error("OAuth state mismatch", {
      received: state,
      stored: req.session?.oauthState,
    });
    return res.redirect("/?error=invalid_state");
  }

  delete req.session.oauthState;

  try {
    // Step 1: Exchange code for short-lived token
    const tokenRes = await axios.get(
      `https://graph.facebook.com/${FB_VERSION}/oauth/access_token`,
      {
        params: {
          client_id: FB_APP_ID,
          client_secret: FB_APP_SECRET,
          redirect_uri: FB_REDIRECT_URI,
          code,
        },
      }
    );

    const shortToken = tokenRes.data.access_token;
    if (!shortToken) {
      console.error("Token exchange failed:", tokenRes.data);
      return res.redirect("/?error=token_exchange_failed");
    }

    // Step 2: Exchange short-lived token for long-lived token (60 days)
    const longTokenRes = await axios.get(
      `https://graph.facebook.com/${FB_VERSION}/oauth/access_token`,
      {
        params: {
          grant_type: "fb_exchange_token",
          client_id: FB_APP_ID,
          client_secret: FB_APP_SECRET,
          fb_exchange_token: shortToken,
        },
      }
    );

    const longToken = longTokenRes.data.access_token;
    const expiresIn = longTokenRes.data.expires_in; // seconds

    // Step 3: Get user info
    const userRes = await axios.get(
      `https://graph.facebook.com/${FB_VERSION}/me`,
      {
        params: {
          fields: "id,name",
          access_token: longToken,
        },
      }
    );

    const fbUserId = userRes.data.id;
    const userName = userRes.data.name;

    // Step 4: Store or update user in database
    const expiresAt = new Date(Date.now() + expiresIn * 1000).toISOString();

    const existingUser = await db.get(
      "SELECT * FROM users WHERE fb_user_id = ?",
      [fbUserId]
    );

    let userId;
    if (existingUser) {
      await db.run(
        `UPDATE users 
         SET user_token = ?, user_token_expires_at = ?, name = ?
         WHERE id = ?`,
        [longToken, expiresAt, userName, existingUser.id]
      );
      userId = existingUser.id;
    } else {
      const result = await db.run(
        `INSERT INTO users (fb_user_id, name, user_token, user_token_expires_at)
         VALUES (?, ?, ?, ?)`,
        [fbUserId, userName, longToken, expiresAt]
      );
      userId = result.lastID;
    }

    // Step 5: Set session
    req.session.userId = userId;
    req.session.userName = userName;
    req.session.facebookAccessToken = longToken;

    console.log("✅ User authenticated:", userName, "| Token expires:", expiresAt);

    res.redirect("/?auth=success");
  } catch (err) {
    console.error("OAuth callback error:", err.response?.data || err.message);
    res.redirect("/?error=authentication_failed");
  }
});

/**
 * Check if user token is expired
 */
router.get("/check-token", async (req, res) => {
  if (!req.session.userId) {
    return res.json({ valid: false, message: "Not authenticated" });
  }

  try {
    const user = await db.get(
      "SELECT user_token_expires_at FROM users WHERE id = ?",
      [req.session.userId]
    );

    if (!user || !user.user_token_expires_at) {
      return res.json({ valid: false, message: "No token found" });
    }

    const expiresAt = new Date(user.user_token_expires_at);
    const now = new Date();
    const isExpired = expiresAt <= now;

    res.json({
      valid: !isExpired,
      expiresAt: user.user_token_expires_at,
      daysRemaining: Math.floor((expiresAt - now) / (1000 * 60 * 60 * 24)),
    });
  } catch (err) {
    console.error("Token check error:", err);
    res.status(500).json({ valid: false, message: "Error checking token" });
  }
});

export default router;