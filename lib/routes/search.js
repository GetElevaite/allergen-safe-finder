import express from "express";

const router = express.Router();
const SERP_KEY = process.env.SERPAPI_API_KEY;

// tiny helpers
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const domainOf = (url = "") => {
  try { return new URL(url).hostname.replace(/^www\./, ""); } catch { return ""; }
};

async function shoppingSearch(q) {
  const url = new URL("https://serpapi.com/search.json");
  url.searchParams.set("engine", "google_shopping");
  url.searchParams.set("q", q);
  url.searchParams.set("gl", "us");
  url.searchParams.set("hl", "en");
  url.searchParams.set("num", "10");
  url.searchParams.set("api_key", SERP_KEY);

  const res = await fetch(url, { timeout: 20000 });
  if (!res.ok) throw new Error(`SerpAPI ${res.status}`);
  return res.json();
}

// crude brand guess from title: first word(s) before a dash or product type
function guessBrand(title = "") {
  const t = title.split(" - ")[0].trim();
  const m = t.match(/^[A-Za-z'’.-]{2,}(?:\s[A-Za-z'’.-]{2,})?/);
  return m ? m[0] : "";
}

/**
 * Build one product card with as many good links as we can:
 * - prefer manufacturer link (brand domain) when present
 * - add 1–2 reputable retailers
 */
function mapShoppingItem(item) {
  const link = item.product_link || item.link || "";
  const source = (item.source || "").trim();       // e.g., "Sephora", "Ulta Beauty"
  const price = item.extracted_price ?? item.price;
  const rating = Number(item.rating) || undefined;
  const reviews = Number(item.reviews) || undefined;

  const brand = (item.brand || guessBrand(item.title) || "").toLowerCase();
  const host = domainOf(link);
  const looksManufacturer =
    brand && (host.includes(brand.replace(/\s+/g, "")) || host.endsWith(`${brand}.com`));

  const out = {
    name: item.title,
    variant: price ? `$${price}` : undefined,
    rating, reviews,
    links: {
      manufacturer: looksManufacturer ? link : undefined,
      retailer1: !looksManufacturer ? link : undefined,
      retailer2: item.product_inventory?.[0]?.link || item.link || undefined
    },
    policy: { ok: true }
  };
  return out;
}

router.post("/", async (req, res) => {
  try {
    if (!SERP_KEY) return res.status(400).json({ error: "Missing SERPAPI_API_KEY" });

    const {
      allergens = [],
      categories = [],
      notes = "",
      rating_floor = 4.0,
      purchase_sites = []
    } = req.body || {};

    // Build a negative-query to try excluding allergens at source
    const minus = allergens.map(a => `-"${a}"`).join(" ");

    const results = [];
    for (const rawCat of categories) {
      const cat = String(rawCat).trim();
      if (!cat) continue;

      // Compose query; keep it short so Google Shopping returns solid matches
      const q = `${cat} ${notes ? notes : ""} ${minus} site:(sephora.com OR ulta.com OR target.com OR amazon.com OR brand.com)`.trim();

      const data = await shoppingSearch(q);
      const items = (data.shopping_results || [])
        .map(mapShoppingItem)
        .filter(p => (p.rating ?? 5) >= Number(rating_floor))
        .slice(0, 5);

      // If user listed preferred sites, reorder links to surface those
      if (purchase_sites?.length) {
        const prefs = purchase_sites.map(s => s.toLowerCase());
        for (const it of items) {
          const links = it.links || {};
          const all = [links.manufacturer, links.retailer1, links.retailer2].filter(Boolean);
          const sorted = all.sort((a, b) => {
            const ha = prefs.some(p => domainOf(a).includes(p));
            const hb = prefs.some(p => domainOf(b).includes(p));
            return Number(hb) - Number(ha);
          });
          links.manufacturer = sorted[0];
          links.retailer1    = sorted[1];
          links.retailer2    = sorted[2];
          it.links = links;
        }
      }

      results.push({ category: cat, items });
      // be polite to SerpAPI free tier
      await sleep(800);
    }

    const message =
      `Found ${results.reduce((n, g) => n + (g.items?.length || 0), 0)} items. ` +
      `All results include clickable links; verify ingredients on the manufacturer page before purchase. ` +
      `These recommendations are informational only and not medical advice.`;

    res.json({ ok: true, results, message });

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Search failed", detail: String(err) });
  }
});

export default router;
