import express from "express";
import fetch from "node-fetch";
import dotenv from "dotenv";
dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

// =============================
// 🔐 TOKEN MANAGEMENT
// =============================
let accessToken = null;
let accessTokenExpiresAt = 0;

async function getAccessToken() {
  const now = Date.now();

  // Masih valid? pakai yang lama
  if (accessToken && now < accessTokenExpiresAt) {
    return accessToken;
  }

  console.log("🔄 Refreshing eBay access token...");

  const auth = Buffer.from(
    `${process.env.EBAY_CLIENT_ID}:${process.env.EBAY_CLIENT_SECRET}`
  ).toString("base64");

  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: process.env.EBAY_REFRESH_TOKEN,
    scope: "https://api.ebay.com/oauth/api_scope",
  });

  const resp = await fetch("https://api.ebay.com/identity/v1/oauth2/token", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: `Basic ${auth}`,
    },
    body,
  });

  const data = await resp.json();

  if (!data.access_token) {
    console.error("❌ Failed to refresh token:", data);
    throw new Error("Cannot refresh eBay access token");
  }

  accessToken = data.access_token;
  // refresh 1 menit sebelum kadaluarsa
  accessTokenExpiresAt = now + (data.expires_in - 60) * 1000;

  console.log("✅ New access token obtained");
  return accessToken;
}

// =============================
// 🌍 MARKET MAP
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
  ES: "EBAY_ES",
};

// Helper kecil untuk panggil Browse API
async function callBrowseSearch({ q, country = "US", extraQuery = "" }) {
  const token = await getAccessToken();
  const marketplace = MARKET_MAP[country.toUpperCase()] || "EBAY_US";

  const url =
    `https://api.ebay.com/buy/browse/v1/item_summary/search?q=${encodeURIComponent(
      q
    )}` + extraQuery;

  const resp = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      "X-EBAY-C-MARKETPLACE-ID": marketplace,
    },
  });

  const json = await resp.json();
  if (!resp.ok) {
    console.error("eBay error:", json);
    throw new Error(json.message || "eBay API error");
  }
  return json;
}

// =============================
// 🔍 BASIC SEARCH
// =============================
app.get("/search", async (req, res) => {
  try {
    const { q, country = "US", limit = 20 } = req.query;

    const json = await callBrowseSearch({
      q,
      country,
      extraQuery: `&limit=${encodeURIComponent(limit)}`,
    });

    res.json(json);
  } catch (err) {
    console.error("Error in /search:", err);
    res.status(500).json({ error: err.message });
  }
});

// =============================
// 📈 PRICE HISTORY (SNAPSHOT)
// =============================
// Menggunakan listing aktif sebagai "market snapshot"
// Return: min, max, avg, median, dan sampel item
app.get("/price-history", async (req, res) => {
  try {
    const { q, country = "US", limit = 50 } = req.query;

    const json = await callBrowseSearch({
      q,
      country,
      extraQuery: `&limit=${encodeURIComponent(limit)}&sort=price`,
    });

    const items = json.itemSummaries || [];

    const prices = items
      .map((it) =>
        it.price && it.price.value != null ? Number(it.price.value) : null
      )
      .filter((v) => !isNaN(v));

    if (prices.length === 0) {
      return res.json({
        query: q,
        country,
        stats: null,
        sampleCount: 0,
        samples: [],
      });
    }

    const sorted = [...prices].sort((a, b) => a - b);
    const min = sorted[0];
    const max = sorted[sorted.length - 1];
    const sum = sorted.reduce((acc, v) => acc + v, 0);
    const avg = sum / sorted.length;
    const median =
      sorted.length % 2 === 1
        ? sorted[(sorted.length - 1) / 2]
        : (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2;

    const currency = items[0]?.price?.currency || "USD";

    const samples = items.slice(0, 20).map((it) => ({
      itemId: it.itemId,
      title: it.title,
      price: it.price,
      condition: it.condition,
      itemWebUrl: it.itemWebUrl,
    }));

    res.json({
      query: q,
      country,
      marketplace: MARKET_MAP[country.toUpperCase()] || "EBAY_US",
      currency,
      stats: {
        min,
        max,
        avg,
        median,
        count: prices.length,
      },
      samples,
    });
  } catch (err) {
    console.error("Error in /price-history:", err);
    res.status(500).json({ error: err.message });
  }
});

// =============================
// 🔥 TRENDING
// =============================
// Logika sederhana: sort item lokal berdasarkan bidCount (desc)
app.get("/trending", async (req, res) => {
  try {
    const { q, country = "US", limit = 20 } = req.query;

    const json = await callBrowseSearch({
      q,
      country,
      extraQuery: `&limit=100`, // ambil agak banyak dulu, nanti dipotong
    });

    const items = (json.itemSummaries || []).map((it) => ({
      ...it,
      _bidCount: typeof it.bidCount === "number" ? it.bidCount : 0,
    }));

    const sorted = items
      .sort((a, b) => b._bidCount - a._bidCount)
      .slice(0, Number(limit) || 20);

    res.json({
      query: q,
      country,
      total: sorted.length,
      items: sorted.map((it) => ({
        itemId: it.itemId,
        title: it.title,
        price: it.price,
        bidCount: it._bidCount,
        condition: it.condition,
        itemWebUrl: it.itemWebUrl,
      })),
    });
  } catch (err) {
    console.error("Error in /trending:", err);
    res.status(500).json({ error: err.message });
  }
});

// =============================
// 🧾 SOLD LISTINGS (PLACEHOLDER)
// =============================
// Catatan: data "sold" yang akurat butuh Marketplace Insights API
// (filter lastSoldDate). Browse API biasa tidak expose status sold.
// Supaya jujur, endpoint ini sementara return 501 dengan pesan jelas.
app.get("/sold-listings", async (req, res) => {
  try {
    return res.status(501).json({
      error: "sold_listings_not_available",
      message:
        "Data sold listings yang akurat membutuhkan eBay Marketplace Insights API (filter lastSoldDate). Saat ini key kamu baru menggunakan Browse API, jadi endpoint ini masih placeholder.",
    });
  } catch (err) {
    console.error("Error in /sold-listings:", err);
    res.status(500).json({ error: err.message });
  }
});

// =============================
// ROOT
// =============================
app.get("/", (req, res) => {
  res.send("Comic Value Backend is running with auto token + extra endpoints.");
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
