import express from "express";
import crypto from "crypto";
import axios from "axios";
import { codeToShortLivedToken, getLongLivedUserToken } from "./token-utils.js";
import { db } from "./db.js";
import dotenv from "dotenv";
dotenv.config();

const router = express.Router();
const FB_VERSION = process.env.FB_GRAPH_VERSION || "v21.0";
const APP_ID = process.env.FB_APP_ID;
const REDIRECT_URI = process.env.FB_REDIRECT_URI;
console.log("FB_APP_ID:", process.env.FB_APP_ID);
console.log("FB_REDIRECT_URI:", process.env.FB_REDIRECT_URI);


// Redirect user to Facebook login
router.get("/login", (req, res) => {
  const state = crypto.randomBytes(16).toString("hex");
  req.session.oauthState = state;

  const scopes = ["pages_show_list", "instagram_basic", "instagram_content_publish"].join(",");

  const url =
    `https://www.facebook.com/${FB_VERSION}/dialog/oauth?client_id=${APP_ID}` +
    `&redirect_uri=${encodeURIComponent(REDIRECT_URI)}` +
    `&state=${state}&scope=${encodeURIComponent(scopes)}`;

  res.redirect(url);
});

// Callback: exchange code -> store long-lived token
router.get("/callback", async (req, res) => {
  try {
    const { code, state } = req.query;
    
    console.log("📥 Callback received");
    
    if (!code || state !== req.session.oauthState) {
      console.error("❌ Invalid OAuth state or missing code");
      return res.status(400).send("Invalid OAuth state or missing code.");
    }

    console.log("🔄 Exchanging code for token...");
    
    // Exchange code -> short token
    const shortData = await codeToShortLivedToken(code, REDIRECT_URI);
    const shortToken = shortData.access_token;

    console.log("✅ Short token received");

    // Exchange -> long-lived user token
    const longData = await getLongLivedUserToken(shortToken);
    const userToken = longData.access_token;
    const expiresIn = longData.expires_in || 5184000; // Default to 60 days if not provided

    console.log(`✅ Long-lived token received (expires in ${expiresIn} seconds)`);

    // Get basic user profile
    const me = await axios.get(`https://graph.facebook.com/${FB_VERSION}/me`, {
      params: { access_token: userToken, fields: "id,name" },
    });

    const fb_user_id = me.data.id;
    const name = me.data.name;
    
    // Calculate expiration date safely
    const expiresAtTimestamp = Date.now() + (expiresIn * 1000);
    const expires_at = new Date(expiresAtTimestamp).toISOString();

    console.log(`👤 User: ${name} (${fb_user_id})`);
    console.log(`⏰ Token expires at: ${expires_at}`);

    // Upsert user into DB
    let userRow = await db.get(`SELECT * FROM users WHERE fb_user_id = ?`, [fb_user_id]);
    
    if (!userRow) {
      console.log("➕ Creating new user in database");
      const r = await db.run(
        `INSERT INTO users (fb_user_id, name, user_token, user_token_expires_at) VALUES (?, ?, ?, ?)`,
        [fb_user_id, name, userToken, expires_at]
      );
      userRow = { 
        id: r.lastID, 
        fb_user_id, 
        name, 
        user_token: userToken, 
        user_token_expires_at: expires_at 
      };
    } else {
      console.log("🔄 Updating existing user in database");
      await db.run(
        `UPDATE users SET user_token = ?, user_token_expires_at = ?, name = ? WHERE id = ?`,
        [userToken, expires_at, name, userRow.id]
      );
      userRow.user_token = userToken;
      userRow.user_token_expires_at = expires_at;
    }

    // Save user id in session
    req.session.userId = userRow.id;
    req.session.userName = name;

    console.log(`✅ User ${name} logged in successfully`);

    // Redirect to homepage
    res.redirect("/");
  } catch (err) {
    console.error("❌ Auth callback error:", err.response?.data || err.message || err);
    res.status(500).send(`Authentication failed: ${err.message}`);
  }
});

export default router;