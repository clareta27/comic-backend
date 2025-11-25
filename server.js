import express from "express";
import fetch from "node-fetch";
import dotenv from "dotenv";
dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

let accessToken = null;
let accessTokenExpiresAt = 0;

// =============================
// 🔄 AUTO REFRESH EBAY TOKEN
// =============================
async function getAccessToken() {
  const now = Date.now();

  if (accessToken && now < accessTokenExpiresAt) {
    return accessToken; // Token masih valid
  }

  console.log("🔄 Refreshing eBay access token...");

  const auth = Buffer.from(
    `${process.env.EBAY_CLIENT_ID}:${process.env.EBAY_CLIENT_SECRET}`
  ).toString("base64");

  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: process.env.EBAY_REFRESH_TOKEN,
    scope: "https://api.ebay.com/oauth/api_scope"
  });

  const resp = await fetch("https://api.ebay.com/identity/v1/oauth2/token", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: `Basic ${auth}`
    },
    body
  });

  const data = await resp.json();

  if (!data.access_token) {
    console.error("❌ Failed to refresh token:", data);
    throw new Error("Cannot refresh eBay access token");
  }

  accessToken = data.access_token;
  accessTokenExpiresAt = now + (data.expires_in - 60) * 1000;

  console.log("✅ New access token obtained");

  return accessToken;
}

// =============================
// 🌍 MARKET MAP (Final)
// =============================
const MARKET_MAP = {
  US: "EBAY_US",
  UK: "EBAY_GB",
  GB: "EBAY_GB",
  CA: "EBAY_CA",
  AU: "EBAY_AU",
  DE: "EBAY_DE",
  FR: "EBAY_FR",
  IT: "EBAY_IT",
  ES: "EBAY_ES"
};

// =============================
// 🔍 SEARCH ENDPOINT
// =============================
app.get("/search", async (req, res) => {
  try {
    const { q, country = "US" } = req.query;

    const token = await getAccessToken();
    const marketplace =
      MARKET_MAP[country.toUpperCase()] || "EBAY_US";

    const response = await fetch(
      `https://api.ebay.com/buy/browse/v1/item_summary/search?q=${encodeURIComponent(
        q
      )}&limit=20`,
      {
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
          "X-EBAY-C-MARKETPLACE-ID": marketplace
        }
      }
    );

    const json = await response.json();
    res.json(json);

  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// =============================
app.get("/", (req, res) => {
  res.send("Comic Value Backend is running with AUTO TOKEN REFRESH.");
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
