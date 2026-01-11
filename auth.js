import express from "express";
import crypto from "crypto";
import fetch from "node-fetch";

const router = express.Router();

/**
 * STEP 1: Start OAuth
 */
router.get("/auth/facebook", (req, res) => {
  if (!req.session) {
    return res.status(500).send("Session not initialized");
  }

  const state = crypto.randomBytes(16).toString("hex");
  req.session.oauthState = state;

  const params = new URLSearchParams({
    client_id: process.env.FACEBOOK_APP_ID,
    redirect_uri: process.env.FACEBOOK_REDIRECT_URI,
    state,
    scope: "pages_show_list,instagram_basic,instagram_content_publish,pages_read_engagement",
    response_type: "code",
  });

  res.redirect(`https://www.facebook.com/v19.0/dialog/oauth?${params}`);
});

/**
 * STEP 2: OAuth Callback
 */
router.get("/auth/facebook/callback", async (req, res) => {
  const { code, state } = req.query;

  // 🔴 REQUIRED FIX #1 — explicit checks
  if (!code) {
    return res.status(400).send("Missing authorization code");
  }

  if (!req.session || !req.session.oauthState || state !== req.session.oauthState) {
    console.error("OAuth state mismatch", {
      received: state,
      stored: req.session?.oauthState,
    });
    return res.status(400).send("Invalid OAuth state");
  }

  // cleanup
  delete req.session.oauthState;

  try {
    // Exchange code for access token
    const tokenRes = await fetch(
      `https://graph.facebook.com/v19.0/oauth/access_token?` +
        new URLSearchParams({
          client_id: process.env.FACEBOOK_APP_ID,
          client_secret: process.env.FACEBOOK_APP_SECRET,
          redirect_uri: process.env.FACEBOOK_REDIRECT_URI,
          code,
        })
    );

    const tokenData = await tokenRes.json();

    if (!tokenData.access_token) {
      console.error("Token exchange failed", tokenData);
      return res.status(500).send("Failed to get access token");
    }

    // Store token in session (or DB if you already do that)
    req.session.facebookAccessToken = tokenData.access_token;

    // Redirect back to app
    res.redirect("/");
  } catch (err) {
    console.error("OAuth callback error:", err);
    res.status(500).send("OAuth failed");
  }
});

export default router;
