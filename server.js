// ======================================================
// COMIC VALUE BACKEND v2 (Auto Trending + Search + Vintage)
// ======================================================

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
  if (!resp.ok || !data.access_token) throw new Error("Cannot refresh eBay token");

  accessToken = data.access_token;
  accessTokenExpiresAt = now + (data.expires_in - 60) * 1000;

  console.log("✅ Token refreshed");
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
function setCache(key, val, ttl) {
  cacheStore.set(key, { val, exp: Date.now() + ttl });
}
function getCache(key) {
  const d = cacheStore.get(key);
  if (!d) return null;
  if (Date.now() > d.exp) {
    cacheStore.delete(key);
    return null;
  }
  return d.val;
}

// =============================
// COMIC FILTERING
// =============================
const BLOCK_WORDS = [
  "sticker", "decal", "magnet",
  "funko", "toy", "poster", "print",
  "shirt", "hoodie", "lot", "bundle",
  "pokemon", "yugioh", "mtg", "lego",
];

function isComic(item) {
  if (!item?.title) return false;
  const t = item.title.toLowerCase();
  if (BLOCK_WORDS.some(w => t.includes(w))) return false;
  return (
    t.includes("comic") ||
    t.includes("variant") ||
    t.includes("key issue") ||
    (item.categories || []).some(c => c.categoryId === "63")
  );
}

// =============================
// GENERIC SEARCH WRAPPER
// =============================
async function ebaySearch({ q, country = "US", extra = "" }) {
  const marketplace = MARKET_MAP[country.toUpperCase()] || "EBAY_US";
  const cacheKey = `s|${marketplace}|${q}|${extra}`;

  const cached = getCache(cacheKey);
  if (cached) return cached;

  const token = await getAccessToken();

  const url =
    `https://api.ebay.com/buy/browse/v1/item_summary/search` +
    `?q=${encodeURIComponent(q)}` +
    `&category_ids=63` +
    extra;

  const resp = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      "X-EBAY-C-MARKETPLACE-ID": marketplace,
    },
  });

  const json = await resp.json();
  if (!resp.ok) throw json;

  setCache(cacheKey, json, 5 * 60 * 1000);
  return json;
}

// ======================================================
// 1) AUTO TRENDING COMICS (NOW WITH VINTAGE SUPPORT!)
// ======================================================
app.get("/trending-auto", async (req, res) => {
  try {
    const { country = "US", limit = 35 } = req.query;

    // Modern + Vintage + Rare
    const queries = [
      // Modern
      "marvel comic",
      "dc comics",
      "variant cover",
      "key issue",
      "spider-man comic",
      "batman comic",
      "x-men comic",

      // Vintage / Golden / Silver / Bronze Age
      "golden age comic",
      "silver age comic",
      "bronze age comic",
      "vintage marvel comic",
      "vintage dc comic",
      "1960 comic",
      "1970 comic",
      "1980 comic",
      "first appearance comic",
      "rare comic",
      "key issue vintage",
    ];

    let found = [];

    for (const q of queries) {
      const json = await ebaySearch({
        q,
        country,
        extra: "&limit=70&sort=price",
      });

      found.push(...(json.itemSummaries || []).filter(isComic));
    }

    // unique by title
    const map = new Map();
    for (const it of found) {
      if (!map.has(it.title)) map.set(it.title, it);
    }

    const unique = [...map.values()];

    // trending score = price × impressions (approx via repeat queries)
    const enriched = unique.map(it => ({
      ...it,
      score: Number(it.price?.value || 0),
    }));

    enriched.sort((a, b) => b.score - a.score);

    res.json({
      country,
      total: enriched.length,
      items: enriched.slice(0, Number(limit)),
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ======================================================
// 2) ADVANCED SEARCH COMICS + SORT + PAGINATION
// ======================================================
app.get("/search", async (req, res) => {
  try {
    const {
      q = "",
      country = "US",
      page = 1,
      limit = 20,
      sort = "price_asc",
    } = req.query;

    const raw = await ebaySearch({
      q,
      country,
      extra: "&limit=200",
    });

    let items = (raw.itemSummaries || []).filter(isComic);

    // Sorting
    if (sort === "price_asc")
      items.sort((a, b) => Number(a.price.value) - Number(b.price.value));

    if (sort === "price_desc")
      items.sort((a, b) => Number(b.price.value) - Number(a.price.value));

    if (sort === "newest")
      items.sort((a, b) => new Date(b.itemCreationDate) - new Date(a.itemCreationDate));

    // Pagination
    const start = (page - 1) * limit;
    const paged = items.slice(start, start + Number(limit));

    res.json({
      country,
      query: q,
      total: items.length,
      page: Number(page),
      limit: Number(limit),
      items: paged.map(it => ({
        itemId: it.itemId,
        title: it.title,
        price: it.price,
        image: it.image?.imageUrl || null,
        url: it.itemWebUrl,
        condition: it.condition,
        shipping: it.shippingOptions?.[0]?.shippingCost || null,
      })),
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ROOT
app.get("/", (req, res) => {
  res.send("Comic Value Backend v2 (Trending Auto + Vintage + Search)");
});

// START SERVER
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});
