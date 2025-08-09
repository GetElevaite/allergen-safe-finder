import express from "express";

const router = express.Router();
const SERP = process.env.SERPAPI_API_KEY;

/* ------------------------- small utils ------------------------- */
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const clean = (s="") => String(s || "").trim();
const norm = (s="") => s.toLowerCase().replace(/\s+/g," ").trim();
const host = (u="") => { try { return new URL(u).hostname.replace(/^www\./,""); } catch { return ""; } };

// basic, extensible synonyms / cross-reactors
const ALLERGEN_SYNONYMS = {
  "amidoamine": [
    "stearamidopropyl dimethylamine", "amidopropyl", "apd", "sapdm"
  ],
  "propolis": ["propolis extract", "bee glue", "cera propolis", "bee resin"],
  "benzophenone-3": ["oxybenzone", "bp-3", "bp3", "benzophenone 3"],
  "benzophenone-4": ["bp-4", "bp4", "benzophenone 4", "sulisobenzone"],
  "sorbitan sesquioleate": ["sso", "sorbitan sesqui oleate", "sorbitan sesqui-oleate"],
  "fragrance mix 1": ["fragrance", "parfum", "perfume"],
  "fragrance mix 2": ["fragrance", "parfum", "perfume"],
  "amerchol": ["lanolin alcohol", "lanolin"]
};

function expandAllergens(input=[]) {
  const set = new Set();
  for (const raw of input) {
    const k = norm(raw);
    if (!k) continue;
    set.add(k);
    (ALLERGEN_SYNONYMS[k] || []).forEach(s => set.add(norm(s)));
  }
  return [...set];
}

async function serpShopping(q){
  const url = new URL("https://serpapi.com/search.json");
  url.searchParams.set("engine","google_shopping");
  url.searchParams.set("q", q);
  url.searchParams.set("gl","us");
  url.searchParams.set("hl","en");
  url.searchParams.set("num","12");
  url.searchParams.set("api_key", SERP);
  const r = await fetch(url, { timeout: 25000 });
  if (!r.ok) throw new Error(`SerpAPI ${r.status}`);
  return r.json();
}

function mapShoppingItem(x){
  const link = x.product_link || x.link || "";
  return {
    name: clean(x.title),
    price: x.extracted_price ?? undefined,
    rating: x.rating ? Number(x.rating) : undefined,
    reviews: x.reviews ? Number(x.reviews) : undefined,
    link,
    brand: clean(x.brand || ""),
    source: clean(x.source || host(link))
  };
}

/* --------------------- ingredient extraction ------------------- */
/**
 * Tries multiple strategies to extract an ingredients/INCI string from HTML:
 * 1) JSON-LD blocks (application/ld+json) — look for "ingredients" fields.
 * 2) Retailer JSON blobs (Sephora, Ulta, Target, Amazon often embed "ingredients").
 * 3) Meta tags (name="ingredients", property="product:ingredients", etc.)
 * 4) Body text near keywords: ingredients / inci / composition / what’s inside.
 */
function extractFromJsonBlocks(html) {
  const results = [];
  const scriptRegex = /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = scriptRegex.exec(html))) {
    const raw = m[1];
    try {
      const obj = JSON.parse(raw);
      const scan = (o) => {
        if (!o || typeof o !== "object") return;
        if (o.ingredients && typeof o.ingredients === "string") {
          results.push(o.ingredients);
        }
        // sometimes nested arrays/objects carry ingredients
        for (const v of Object.values(o)) {
          if (Array.isArray(v)) v.forEach(scan);
          else if (v && typeof v === "object") scan(v);
        }
      };
      scan(obj);
    } catch { /* ignore */ }
  }
  return results;
}

function extractFromRetailerJson(html) {
  // catch "ingredients":"..." style in embedded state blobs
  const hits = [];
  const ingPair = /"ingredients"\s*:\s*"([^"]{10,})"/gi;
  let m;
  while ((m = ingPair.exec(html))) hits.push(m[1]);

  // Sephora sometimes uses ingredient_desc or productDetails for ingredients
  const seph1 = /"ingredient_desc"\s*:\s*"([^"]{10,})"/gi;
  while ((m = seph1.exec(html))) hits.push(m[1]);
  const seph2 = /"ingredientsText"\s*:\s*"([^"]{10,})"/gi;
  while ((m = seph2.exec(html))) hits.push(m[1]);

  // Ulta/Target variations
  const tgt = /"item_ingredients"\s*:\s*"([^"]{10,})"/gi;
  while ((m = tgt.exec(html))) hits.push(m[1]);

  return hits;
}

function extractFromMeta(html) {
  const hits = [];
  const meta = /<meta[^>]+(?:name|property)=["'](?:ingredients|product:ingredients)["'][^>]+content=["']([^"']{10,})["'][^>]*>/gi;
  let m;
  while ((m = meta.exec(html))) hits.push(m[1]);
  return hits;
}

function extractNearKeywords(html) {
  // Pull windows around keywords
  const lower = html.toLowerCase();
  const keys = ["ingredients", "inci", "composition", "what's inside"];
  const chunks = [];
  for (const k of keys) {
    let idx = 0;
    while ((idx = lower.indexOf(k, idx)) !== -1) {
      const slice = lower.slice(Math.max(0, idx - 800), idx + 2000);
      // strip tags & compress ws
      const text = slice.replace(/<[^>]+>/g," ").replace(/\s+/g," ").trim();
      if (text.length > 40) chunks.push(text);
      idx += k.length;
    }
  }
  return chunks;
}

async function fetchIngredients(url) {
  try {
    const r = await fetch(url, { redirect: "follow", timeout: 25000 });
    const html = await r.text();

    const pools = [
      ...extractFromJsonBlocks(html),
      ...extractFromRetailerJson(html),
      ...extractFromMeta(html),
      ...extractNearKeywords(html)
    ];

    // return first substantial string
    const best = pools
      .map(t => t.replace(/&nbsp;|&amp;|&lt;|&gt;/g, " "))
      .map(t => t.replace(/\s+/g, " ").trim())
      .sort((a,b)=>b.length - a.length)[0] || "";

    return norm(best);
  } catch {
    return "";
  }
}

function containsAllergen(text, allergens=[]) {
  if (!text) return false;
  const t = norm(text);
  return allergens.some(a => t.includes(a));
}

/* --------------------------- route ---------------------------- */
router.post("/", async (req, res) => {
  try {
    if (!SERP) return res.status(400).json({ ok:false, error:"Missing SERPAPI_API_KEY" });

    const body = req.body || {};
    const categories = (body.categories || []).map(clean).filter(Boolean);
    const allergensIn = (body.allergens || []).map(clean).filter(Boolean);
    const ratingFloor = Number(body.rating_floor ?? 4.0);
    const preferred = (body.purchase_sites || []).map(s => s.toLowerCase());

    const allergens = expandAllergens(allergensIn);

    const results = [];

    for (const cat of categories) {
      // broader query first; fallback to beauty retailers if empty
      const q1 = `${cat} fragrance free`;
      const q2 = `${cat} site:(sephora.com OR ulta.com OR target.com OR amazon.com)`;

      let data = await serpShopping(q1);
      let items = (data.shopping_results || []).map(mapShoppingItem);

      if (!items.length) {
        await sleep(600);
        data = await serpShopping(q2);
        items = (data.shopping_results || []).map(mapShoppingItem);
      }

      const kept = [];
      for (const it of items) {
        if ((it.rating ?? 5) < ratingFloor) continue;

        // ingredient screening
        const inci = await fetchIngredients(it.link);
        if (containsAllergen(inci, allergens)) continue;

        // prioritize preferred domains
        const d = host(it.link).toLowerCase();
        it.priority = preferred.some(p => d.includes(p)) ? 1 : 0;

        kept.push({
          name: it.name,
          rating: it.rating,
          reviews: it.reviews,
          price: it.price,
          links: {
            manufacturer: (it.brand && d.includes(it.brand.toLowerCase().replace(/\s+/g,""))) ? it.link : undefined,
            primary: it.link
          },
          source: it.source
        });

        if (kept.length >= 8) break; // limit per category
        await sleep(250);
      }

      kept.sort((a,b) => (b.priority - a.priority) || ((b.rating||0)-(a.rating||0)));
      results.push({ category: cat, items: kept });
      await sleep(600);
    }

    res.json({
      ok: true,
      results,
      message: `Screened against (${allergens.join(", ") || "none"}). Verify on the manufacturer page before purchase.`
    });

  } catch (err) {
    console.error(err);
    res.status(500).json({ ok:false, error:"Search failed", detail:String(err) });
  }
});

export default router;

