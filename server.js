import express from "express";
import fetch from "node-fetch";
import dotenv from "dotenv";
dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

const EBAY_TOKEN = process.env.EBAY_TOKEN;

const MARKET_MAP = {
  US: "EBAY_US",
  UK: "EBAY_GB",
  GB: "EBAY_GB",
  AU: "EBAY_AU",
  CA: "EBAY_CA",
  DE: "EBAY_DE",
  FR: "EBAY_FR",
  IT: "EBAY_IT",
  ES: "EBAY_ES",
  AT: "EBAY_AT",
  NL: "EBAY_NL",
  CH: "EBAY_CH",
  IE: "EBAY_IE",
  PL: "EBAY_PL",
  SG: "EBAY_SG",
  HK: "EBAY_HK",
  MY: "EBAY_MY",
  PH: "EBAY_PH"
};

function mapCountry(country) {
  if (!country) return "EBAY_US";
  const upper = country.toUpperCase();
  return MARKET_MAP[upper] || "EBAY_US";
}

app.get("/comic", async (req, res) => {
  try {
    const title = req.query.title;
    const country = req.query.country || "US";

    if (!title) {
      return res.status(400).json({ error: "Parameter 'title' wajib diisi" });
    }

    const market = mapCountry(country);

    const url = `https://api.ebay.com/buy/browse/v1/item_summary/search?q=${encodeURIComponent(
      title
    )}`;

    const response = await fetch(url, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${EBAY_TOKEN}`,
        "X-EBAY-C-MARKETPLACE-ID": market,
        "Content-Type": "application/json"
      }
    });

    const data = await response.json();

    return res.json({
      title,
      country,
      marketplace: market,
      results: data
    });
  } catch (err) {
    return res.status(500).json({
      error: err.message
    });
  }
});

app.get("/", (req, res) => {
  res.send("Comic Value Backend is running.");
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
