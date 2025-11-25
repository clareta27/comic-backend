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
  if (accessToken && now < accessTokenExpiresAt) return accessToken;

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
    console.error("❌ Failed to refresh:", data);
    throw new Error("Cannot refresh eBay access token");
  }

  accessToken = data.access_token;
  accessTokenExpiresAt = now + (data.expires_in - 60) * 1000;

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
// CACHE
// =============================
const cacheStore = new Map();
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
// COMIC FILTERS
// =============================
const COMIC_CATEGORY_IDS = new Set(["63", "60252", "17076"]);

const BLOCK_KEYWORDS = [
  "sticker", "stickers", "decal", "magnet",
  "trading card", "pokemon", "mtg", "yugioh",
  "poster", "print", "t-shirt", "shirt", "hoodie",
  "funko", "toy", "lego",
  "mug", "cup", "pin", "patch",
  "bundle", "lot", "set of",
];

function isLikelyComicItem(it) {
  const title = (it.title || "").toLowerCase();

  // buang kata negatif
  if (BLOCK_KEYWORDS.some((k) => title.includes(k))) return false;

  // cek kategori komik
  const cats = it.categories || [];
  if (cats.length > 0) {
    const ids = cats.map((c) => String(c.categoryId));
    if (!ids.some((id) => COMIC_CATEGORY_IDS.has(id))) return false;
  }

  // fallback: jika judul mengandung comic
  if (
    title.includes("comic") ||
    title.includes("comics") ||
    title.includes("tpb") ||
    title.includes("trade paperback")
  ) {
    return true;
  }

  // kalau tanpa kategori dan tidak terlihat komik → buang
  if (!cats.length) return false;

  return true;
}

// =============================
// BROWSE SEARCH (ONLY COMICS)
// =============================
async function callBrowseSearch({ q, country = "US", extraQuery = "" }) {
  const marketplace = MARKET_MAP[country.toUpperCase()] || "EBAY_US";

  const key = `browse|${marketplace}|${q}|${extraQuery}`;
  const cached = getCache(key);
  if (cached) return cached;

  const token = await getAccessToken();

  const url =
    `https://api.ebay.com/buy/browse/v1/item_summary/search` +
    `?q=${encodeURIComponent(q)}` +
    `&category_ids=63` +            // <= FOKUS KE KOMIK
    extraQuery;

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

  setCache(key, data, 5 * 60 * 1000);
  return data;
}

// =============================
// PRICE STATS
// =============================
async function getPriceStats({ q, country = "US", limit = 50 }) {
  const json = await callBrowseSearch({
    q,
    country,
    extraQuery: `&limit=${limit}&sort=price`,
  });

  const filtered = (json.itemSummaries || []).filter(isLikelyComicItem);

  const prices = filtered
    .map((it) =>
      it.price?.value ? Number(it.price.value) : null
    )
    .filter((v) => !isNaN(v));

  if (!prices.length) {
    return { stats: null, currency: "USD", samples: [] };
  }

  const sorted = [...prices].sort((a, b) => a - b);
  const min = sorted[0];
  const max = sorted[sorted.length - 1];
  const avg = sorted.reduce((a, b) => a + b, 0) / sorted.length;
  const median =
    sorted.length % 2
      ? sorted[(sorted.length - 1) / 2]
      : (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2;

  const currency = filtered[0].price.currency;

  const samples = filtered.slice(0, 20).map((it) => ({
    itemId: it.itemId,
    title: it.title,
    price: it.price,
    condition: it.condition,
    itemWebUrl: it.itemWebUrl,
    image: it.image?.imageUrl || null,
  }));

  return { stats: { min, max, avg, median, count: prices.length }, currency, samples };
}

// =============================
// PRICE HISTORY
// =============================
app.get("/price-history", async (req, res) => {
  try {
    const { q, country = "US", limit = 50 } = req.query;
    const result = await getPriceStats({ q, country, limit: Number(limit) });

    res.json({
      query: q,
      country,
      marketplace: MARKET_MAP[country.toUpperCase()] || "EBAY_US",
      currency: result.currency,
      stats: result.stats,
      samples: result.samples,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// =============================
// TRENDING
// =============================
app.get("/trending", async (req, res) => {
  try {
    const { country = "US" } = req.query;

    const titles = [
      "Ultimate Fallout 4",
      "Amazing Spider-Man 300",
      "Incredible Hulk 181",
      "Giant-Size X-Men 1",
      "Batman Adventures 12",
    ];

    const results = [];

    for (const t of titles) {
      try {
        const { stats, currency, samples } = await getPriceStats({
          q: t,
          country,
          limit: 40,
        });

        if (!stats || !samples.length) continue;

        results.push({
          title: t,
          avgPrice: stats.avg,
          currency,
          sample: samples[0],
        });
      } catch {}
    }

    res.json({ country, items: results });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// =============================
// MARKET MOVERS (price delta)
// =============================
const marketHistory = new Map();
let marketMoversCache = null;
let marketMoversCacheExpiresAt = 0;

app.get("/market-movers", async (req, res) => {
  try {
    const { country = "US" } = req.query;

    const now = Date.now();
    if (marketMoversCache && now < marketMoversCacheExpiresAt) {
      return res.json(marketMoversCache);
    }

    const titles = [
      "Ultimate Fallout 4",
      "Amazing Spider-Man 300",
      "Incredible Hulk 181",
      "Giant-Size X-Men 1",
      "Batman Adventures 12",
    ];

    const movers = [];

    for (const t of titles) {
      const { stats, currency, samples } = await getPriceStats({
        q: t,
        country,
        limit: 60,
      });

      if (!stats || !samples.length) continue;

      const key = `${country}|${t.toLowerCase()}`;
      const prev = marketHistory.get(key);

      let prevAvg = prev?.lastAvg ?? stats.avg;
      let changeAbs = stats.avg - prevAvg;
      let changePct = prevAvg ? (changeAbs / prevAvg) * 100 : 0;

      marketHistory.set(key, {
        lastAvg: stats.avg,
        prevAvg,
        lastUpdated: now,
      });

      movers.push({
        title: t,
        currency,
        country,
        currentAvg: stats.avg,
        previousAvg: prevAvg,
        changeAbs,
        changePct,
        direction: changeAbs > 0 ? "up" : changeAbs < 0 ? "down" : "flat",
        sample: samples[0],
      });
    }

    movers.sort((a, b) => Math.abs(b.changePct) - Math.abs(a.changePct));

    const payload = {
      country,
      updatedAt: new Date(now).toISOString(),
      items: movers,
    };

    marketMoversCache = payload;
    marketMoversCacheExpiresAt = now + 2 * 60 * 1000;

    res.json(payload);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// =============================
// SOLD LISTINGS PLACEHOLDER
// =============================
app.get("/sold-listings", (req, res) => {
  res.status(501).json({
    error: "sold_listings_not_available",
    message: "Sold listings require Marketplace Insights API.",
  });
});

// ROOT
app.get("/", (req, res) => {
  res.send("Comic Value Backend is running with comic-only filtering.");
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
