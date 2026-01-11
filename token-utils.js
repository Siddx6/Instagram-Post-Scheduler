import axios from "axios";
import dotenv from "dotenv";
dotenv.config();

export async function codeToShortLivedToken(code, redirect_uri) {
  const res = await axios.get("https://graph.facebook.com/v21.0/oauth/access_token", {
    params: {
      client_id: process.env.FB_APP_ID,
      client_secret: process.env.FB_APP_SECRET,
      redirect_uri,
      code,
    },
  });
  return res.data; // { access_token, token_type, expires_in }
}

export async function getLongLivedUserToken(shortToken) {
  const res = await axios.get("https://graph.facebook.com/v21.0/oauth/access_token", {
    params: {
      grant_type: "fb_exchange_token",
      client_id: process.env.FB_APP_ID,
      client_secret: process.env.FB_APP_SECRET,
      fb_exchange_token: shortToken,
    },
  });
  return res.data; // { access_token, token_type, expires_in }
}

