import express from "express";
import crypto from "crypto";
import axios from "axios";
import { codeToShortLivedToken, getLongLivedUserToken } from "./token-utils.js";
import { db } from "./db.js";
import dotenv from "dotenv";

dotenv.config();

const router = express.Router();
const FB_VERSION = process.env.FB_GRAPH_VERSION || "v21.0";

// =======================
// FACEBOOK LOGIN ROUTE
// =======================
router.get("/login", (req, res) => {
  // 🔴 READ ENV VARS AT RUNTIME (IMPORTANT)
  const APP_ID = process.env.FB_APP_ID;
  const REDIRECT_URI = process.env.FB_REDIRECT_URI;

  console.log("FB_APP_ID =", APP_ID);
  console.log("FB_REDIRECT_URI =", REDIRECT_URI);

  if (!APP_ID || !REDIRECT_URI) {
    console.error("❌ Missing Facebook OAuth environment variables");
    return res.status(500).send("Facebook OAuth environment variables missing");
  }

  const state = crypto.randomBytes(16).toString("hex");
  req.session.oauthState = state;

  const scopes = [
    "pages_show_list",
    "instagram_basic",
    "instagram_content_publish",
  ].join(",");

  const url =
    `https://www.facebook.com/${FB_VERSION}/dialog/oauth` +
    `?client_id=${APP_ID}` +
    `&redirect_uri=${encodeURIComponent(REDIRECT_URI)}` +
    `&state=${state}` +
    `&scope=${encodeURIComponent(scopes)}`;

  res.redirect(url);
});

// =======================
// FACEBOOK CALLBACK ROUTE
// =======================
router.get("/callback", async (req, res) => {
  try {
    const { code, state } = req.query;

    console.log("📥 Callback received");

    if (!code || state !== req.session.oauthState) {
      console.error("❌ Invalid OAuth state or missing code");
      return res.status(400).send("Invalid OAuth state or missing code.");
    }

    console.log("🔄 Exchanging code for token...");

    // 🔴 READ REDIRECT URI AT RUNTIME AGAIN
    const REDIRECT_URI = process.env.FB_REDIRECT_URI;

    if (!REDIRECT_URI) {
      console.error("❌ Missing FB_REDIRECT_URI in callback");
      return res.status(500).send("Facebook redirect URI missing");
    }

    // Exchange code -> short-lived token
    const shortData = await codeToShortLivedToken(code, REDIRECT_URI);
    const shortToken = shortData.access_token;

    console.log("✅ Short token received");

    // Exchange -> long-lived user token
    const longData = await getLongLivedUserToken(shortToken);
    const userToken = longData.access_token;
    const expiresIn = longData.expires_in || 5184000; // ~60 days

    console.log(`✅ Long-lived token received (expires in ${expiresIn} seconds)`);

    // Get user profile
    const me = await axios.get(
      `https://graph.facebook.com/${FB_VERSION}/me`,
      {
        params: {
          access_token: userToken,
          fields: "id,name",
        },
      }
    );

    const fb_user_id = me.data.id;
    const name = me.data.name;

    const expiresAt = new Date(Date.now() + expiresIn * 1000).toISOString();

    console.log(`👤 User: ${name} (${fb_user_id})`);
    console.log(`⏰ Token expires at: ${expiresAt}`);

    // Upsert user
    let userRow = await db.get(
      `SELECT * FROM users WHERE fb_user_id = ?`,
      [fb_user_id]
    );

    if (!userRow) {
      console.log("➕ Creating new user");
      const r = await db.run(
        `INSERT INTO users (fb_user_id, name, user_token, user_token_expires_at)
         VALUES (?, ?, ?, ?)`,
        [fb_user_id, name, userToken, expiresAt]
      );

      userRow = {
        id: r.lastID,
        fb_user_id,
        name,
        user_token: userToken,
        user_token_expires_at: expiresAt,
      };
    } else {
      console.log("🔄 Updating existing user");
      await db.run(
        `UPDATE users
         SET user_token = ?, user_token_expires_at = ?, name = ?
         WHERE id = ?`,
        [userToken, expiresAt, name, userRow.id]
      );
    }

    // Save session
    req.session.userId = userRow.id;
    req.session.userName = name;

    console.log(`✅ User ${name} logged in successfully`);

    res.redirect("/");
  } catch (err) {
    console.error(
      "❌ Auth callback error:",
      err.response?.data || err.message || err
    );
    res.status(500).send("Authentication failed");
  }
});

export default router;
