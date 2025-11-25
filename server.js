import express from "express";
import fetch from "node-fetch";
import dotenv from "dotenv";
dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

// =============================
// TOKEN MANAGEMENT
// =============================
let accessToken = null;
let accessTokenExpiresAt = 0;

async function getAccessToken() {
  const now = Date.now();
  if (accessToken && now < accessTokenExpiresAt) {
    return accessToken;
  }

  console.log("🔄 Refreshing eBay access token...");

  const clientId = process.env.EBAY_CLIENT_ID;
  const clientSecret = process.env.EBAY_CLIENT_SECRET;
  const refreshToken = process.env.EBAY_REFRESH_TOKEN;

  if (!clientId || !clientSecret || !refreshToken) {
    throw new Error("Missing EBAY_CLIENT_ID / EBAY_CLIENT_SECRET / EBAY_REFRESH_TOKEN");
  }

  const auth = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");

  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: refreshToken,
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

  if (!resp.ok || !data.access_token) {
    console.error("❌ Failed to refresh token:", data);
    throw new Error("Cannot refresh eBay access token");
  }

  accessToken = data.access_token;
  accessTokenExpiresAt = now + (data.expires_in - 60) * 1000; // refresh 1m early
  console.log("✅ New access token obtained");

  return accessToken;
}

// =============================
// MARKET MAP
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

// =============================
// SIMPLE IN-MEMORY CACHE
// =============================
const cacheStore = new Map(); // key -> { value, expiresAt }

function setCache(key, value, ttlMs) {
  cacheStore.set(key, { value, expiresAt: Date.now() + ttlMs });
}

function getCache(key) {
  const entry = cacheStore.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    cacheStore.delete(key);
    return null;
  }
  return entry.value;
}

// =============================
// HELPER: BROWSE SEARCH with CACHE
// =============================
async function callBrowseSearch({ q, country = "US", extraQuery = "" }) {
  const marketplace = MARKET_MAP[country.toUpperCase()] || "EBAY_US";
  const key = `browse|${marketplace}|${q}|${extraQuery}`;

  const cached = getCache(key);
  if (cached) return cached;

  const token = await getAccessToken();

  const url =
    `https://api.ebay.com/buy/browse/v1/item_summary/search?q=${encodeURIComponent(
      q
    )}` + extraQuery;

  console.log("🌐 Fetching eBay:", url);

  const resp = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      "X-EBAY-C-MARKETPLACE-ID": marketplace,
    },
  });

  const data = await resp.json();
  if (!resp.ok) {
    console.error("eBay error:", data);
    throw new Error(data.message || "eBay API error");
  }

  // Cache 5 menit
  setCache(key, data, 5 * 60 * 1000);
  return data;
}

// =============================
// HELPER: PRICE STATS
// =============================
async function getPriceStats({ q, country = "US", limit = 50 }) {
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

  if (!prices.length) {
    return {
      stats: null,
      currency: "USD",
      samples: [],
    };
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
    image: it.image?.imageUrl || null,
  }));

  return {
    stats: { min, max, avg, median, count: prices.length },
    currency,
    samples,
  };
}

// =============================
// PRICE HISTORY ENDPOINT
// =============================
app.get("/price-history", async (req, res) => {
  try {
    const { q, country = "US", limit = 50 } = req.query;

    const { stats, currency, samples } = await getPriceStats({
      q,
      country,
      limit: Number(limit) || 50,
    });

    res.json({
      query: q,
      country,
      marketplace: MARKET_MAP[country.toUpperCase()] || "EBAY_US",
      currency,
      stats,
      samples,
    });
  } catch (err) {
    console.error("Error in /price-history:", err);
    res.status(500).json({ error: err.message });
  }
});

// =============================
// SIMPLE TRENDING (snapshot)
// =============================
app.get("/trending", async (req, res) => {
  try {
    const { country = "US" } = req.query;

    const trendingTitles = [
      "Ultimate Fallout 4",
      "Amazing Spider-Man 300",
      "Incredible Hulk 181",
      "Giant-Size X-Men 1",
      "Batman Adventures 12",
    ];

    const results = [];

    for (const title of trendingTitles) {
      try {
        const { stats, currency, samples } = await getPriceStats({
          q: title,
          country,
          limit: 40,
        });

        if (!stats || !samples.length) continue;

        results.push({
          title,
          avgPrice: stats.avg,
          currency,
          sample: samples[0],
        });
      } catch (e) {
        console.warn("Trending title failed:", title, e.message);
      }
    }

    res.json({
      country,
      items: results,
    });
  } catch (err) {
    console.error("Error in /trending:", err);
    res.status(500).json({ error: err.message });
  }
});

// =============================
// MARKET MOVERS (DAY-TO-DAY CHANGE)
// =============================

// store historical snapshots per (country + title)
const marketHistory = new Map();
// cache entire endpoint result for speed
let marketMoversCache = null;
let marketMoversCacheExpiresAt = 0;

app.get("/market-movers", async (req, res) => {
  try {
    const { country = "US" } = req.query;

    // 1) endpoint-level cache (2 menit)
    const now = Date.now();
    if (marketMoversCache && now < marketMoversCacheExpiresAt) {
      return res.json(marketMoversCache);
    }

    const titlesParam = req.query.titles; // optional ?titles=A,B,C
    const moversTitles = titlesParam
      ? String(titlesParam)
          .split(",")
          .map((s) => s.trim())
          .filter((s) => s.isNotEmpty)
      : [
          "Ultimate Fallout 4",
          "Amazing Spider-Man 300",
          "Incredible Hulk 181",
          "Giant-Size X-Men 1",
          "Batman Adventures 12",
        ];

    const movers = [];

    for (const title of moversTitles) {
      try {
        const { stats, currency, samples } = await getPriceStats({
          q: title,
          country,
          limit: 60,
        });

        if (!stats || !samples.length) continue;

        const key = `${country}|${title.toLowerCase()}`;
        const prev = marketHistory.get(key);

        let prevAvg = prev?.lastAvg ?? stats.avg;
        let changeAbs = stats.avg - prevAvg;
        let changePct = prevAvg > 0 ? (changeAbs / prevAvg) * 100 : 0;

        // update history: shift lastAvg -> prevAvg
        marketHistory.set(key, {
          lastAvg: stats.avg,
          prevAvg,
          lastUpdated: now,
        });

        movers.push({
          title,
          country,
          currency,
          currentAvg: stats.avg,
          previousAvg: prevAvg,
          changeAbs,
          changePct,
          direction:
            changeAbs > 0 ? "up" : changeAbs < 0 ? "down" : "flat",
          sample: samples[0],
        });
      } catch (e) {
        console.warn("Market mover fail:", title, e.message);
      }
    }

    // Sort by biggest absolute percentage mover
    movers.sort((a, b) => Math.abs(b.changePct) - Math.abs(a.changePct));

    const payload = {
      country,
      updatedAt: new Date(now).toISOString(),
      items: movers,
    };

    // set endpoint cache 2 menit
    marketMoversCache = payload;
    marketMoversCacheExpiresAt = now + 2 * 60 * 1000;

    res.json(payload);
  } catch (err) {
    console.error("Error in /market-movers:", err);
    res.status(500).json({ error: err.message });
  }
});

// =============================
// SOLD LISTINGS PLACEHOLDER
// =============================
app.get("/sold-listings", (req, res) => {
  return res.status(501).json({
    error: "sold_listings_not_available",
    message:
      "Sold listings require eBay Marketplace Insights API. Current app only uses Browse API.",
  });
});

// ROOT
app.get("/", (req, res) => {
  res.send("Comic Value Backend is running with market-movers + caching.");
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
