import express from "express";

const router = express.Router();
const SERP = process.env.SERPAPI_API_KEY;

/* ---------- tiny utils ---------- */
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const clean = (s="") => String(s || "").trim();
const norm  = (s="") => s.toLowerCase().replace(/\s+/g," ").trim();
const host  = (u="") => { try { return new URL(u).hostname.replace(/^www\./,""); } catch { return ""; } };

async function fetchWithTimeout(url, opts = {}, ms = 20000) {
  const ctrl = new AbortController();
  const id = setTimeout(() => ctrl.abort(), ms);
  try { return await fetch(url, { ...opts, signal: ctrl.signal }); }
  finally { clearTimeout(id); }
}

/* ---------- allergen expansion ---------- */
const ALLERGEN_SYNONYMS = {
  "amidoamine": [ "stearamidopropyl dimethylamine", "amidopropyl", "apd", "sapdm" ],
  "propolis": [ "propolis extract", "bee glue", "cera propolis", "bee resin" ],
  "benzophenone-3": [ "oxybenzone", "bp-3", "bp3", "benzophenone 3" ],
  "benzophenone-4": [ "bp-4", "bp4", "benzophenone 4", "sulisobenzone" ],
  "sorbitan sesquioleate": [ "sso", "sorbitan sesqui oleate", "sorbitan sesqui-oleate" ],
  "fragrance mix 1": [ "fragrance", "parfum", "perfume" ],
  "fragrance mix 2": [ "fragrance", "parfum", "perfume" ],
  "amerchol": [ "lanolin alcohol", "lanolin" ]
};

function expandAllergens(input=[]) {
  const set = new Set();
  for (const raw of input) {
    const k = norm(raw); if (!k) continue;
    set.add(k);
    (ALLERGEN_SYNONYMS[k] || []).forEach(s => set.add(norm(s)));
  }
  return [...set];
}

/* ---------- SerpAPI helpers ---------- */
async function resolveLocationCanonical(userLoc) {
  const q = clean(userLoc);
  if (!q) return null;
  try {
    const url = new URL("https://serpapi.com/locations.json");
    url.searchParams.set("q", q);
    url.searchParams.set("limit", "1");
    url.searchParams.set("api_key", SERP);
    const r = await fetchWithTimeout(url, {}, 3500);
    if (!r.ok) return null;
    const arr = await r.json();
    if (!Array.isArray(arr) || !arr.length) return null;
    return clean(arr[0].canonical_name || arr[0].name);
  } catch {
    return null;
  }
}

// Robust: try with location; if SerpAPI rejects it, fall back without location
async function serpShopping(q, locationCanonical) {
  const base = () => {
    const url = new URL("https://serpapi.com/search.json");
    url.searchParams.set("engine", "google_shopping");
    url.searchParams.set("q", q);
    url.searchParams.set("gl", "us");
    url.searchParams.set("hl", "en");
    url.searchParams.set("num", "12");
    url.searchParams.set("api_key", SERP);
    return url;
  };

  const tryFetch = async (loc) => {
    const url = base();
    if (loc) url.searchParams.set("location", loc);
    const r = await fetchWithTimeout(url, {}, 20000);
    if (!r.ok) return { ok:false, status:r.status, body: await r.text().catch(()=> "") };
    return { ok:true, json: await r.json() };
  };

  if (locationCanonical) {
    const a = await tryFetch(locationCanonical);
    if (a.ok) return a.json;
    console.error("SerpAPI failed with location:", locationCanonical, a.status, a.body?.slice?.(0,200));
  }

  const b = await tryFetch(null);
  if (b.ok) return b.json;

  throw new Error(`SerpAPI error: status=${b.status || "unknown"}`);
}

function mapShoppingItem(x){
  const link = x.product_link || x.link || "";
  return {
    name: clean(x.title),
    price: x.extracted_price ?? undefined,          // number
    rating: x.rating ? Number(x.rating) : undefined,
    reviews: x.reviews ? Number(x.reviews) : undefined,
    link,
    brand: clean(x.brand || ""),
    source: clean(x.source || host(link)),
    thumbnail: x.thumbnail || undefined,
  };
}

/* ---------- ingredient extraction (tight) ---------- */
function extractFromJsonBlocks(html) {
  const res = [];
  const re = /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let m; while ((m = re.exec(html))) {
    try {
      const obj = JSON.parse(m[1]);
      const scan = (o) => {
        if (!o || typeof o !== "object") return;
        if (o.ingredients && typeof o.ingredients === "string") res.push(o.ingredients);
        for (const v of Object.values(o)) {
          if (Array.isArray(v)) v.forEach(scan);
          else if (v && typeof v === "object") scan(v);
        }
      };
      scan(obj);
    } catch {}
  }
  return res;
}
function extractFromRetailerJson(html) {
  const hits = [];
  const pairs = [
    /"ingredients"\s*:\s*"([^"]{10,})"/gi,
    /"ingredient_desc"\s*:\s*"([^"]{10,})"/gi,
    /"ingredientsText"\s*:\s*"([^"]{10,})"/gi,
    /"item_ingredients"\s*:\s*"([^"]{10,})"/gi
  ];
  for (const re of pairs) { let m; while ((m = re.exec(html))) hits.push(m[1]); }
  return hits;
}
function extractFromMeta(html) {
  const hits = [];
  const meta = /<meta[^>]+(?:name|property)=["'](?:ingredients|product:ingredients)["'][^>]+content=["']([^"']{10,})["'][^>]*>/gi;
  let m; while ((m = meta.exec(html))) hits.push(m[1]);
  return hits;
}
function extractNearKeywords(html) {
  const lower = html.toLowerCase();
  const keys = ["ingredients", "inci", "composition", "what's inside"];
  const chunks = [];
  for (const k of keys) {
    let idx = 0;
    while ((idx = lower.indexOf(k, idx)) !== -1) {
      const slice = lower.slice(Math.max(0, idx - 800), idx + 2000);
      const text = slice.replace(/<[^>]+>/g," ").replace(/\s+/g," ").trim();
      if (text.length > 40) chunks.push(text);
      idx += k.length;
    }
  }
  return chunks;
}
async function fetchIngredients(url) {
  try {
    const r = await fetchWithTimeout(url, { redirect: "follow" }, 20000);
    const html = await r.text();
    const pools = [
      ...extractFromJsonBlocks(html),
      ...extractFromRetailerJson(html),
      ...extractFromMeta(html),
      ...extractNearKeywords(html)
    ];
    const best = pools
      .map(t => t.replace(/&nbsp;|&amp;|&lt;|&gt;/g, " "))
      .map(t => t.replace(/\s+/g, " ").trim())
      .sort((a,b)=>b.length - a.length)[0] || "";
    return norm(best);
  } catch { return ""; }
}
function containsAllergen(text, allergens=[]) {
  if (!text) return false;
  const t = norm(text);
  return allergens.some(a => t.includes(a));
}

/* ---------- image resolver (thumbnail → og:image) ---------- */
const ogImageCache = new Map();
const MAX_CACHE = 500;
function cacheGet(k) { return ogImageCache.get(k); }
function cacheSet(k, v) {
  ogImageCache.set(k, v);
  if (ogImageCache.size > MAX_CACHE) {
    const firstKey = ogImageCache.keys().next().value;
    ogImageCache.delete(firstKey);
  }
}
function normalizeHttps(u) { try { return u.replace(/^http:\/\//i, "https://"); } catch { return u; } }

async function resolveImageForItem(item) {
  const direct = item.image || item.thumbnail || (Array.isArray(item.images) && item.images[0]) || null;
  if (direct && /^https?:\/\//i.test(direct)) return normalizeHttps(direct);

  const link = item?.links?.primary || item?.links?.manufacturer || item?.link;
  if (!link) return null;

  const cached = cacheGet(link);
  if (cached !== undefined) return cached;

  try {
    const r = await fetchWithTimeout(link, {
      redirect: "follow",
      headers: { "User-Agent": "Mozilla/5.0 (AllergenSafeFinder bot)", "Accept": "text/html,application/xhtml+xml" }
    }, 4500);
    if (!r.ok) { cacheSet(link, null); return null; }

    const html = await r.text();

    let m = html.match(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i) ||
            html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image["']/i);
    let url = m ? m[1] : null;

    if (!url) {
      m = html.match(/<meta[^>]+name=["']twitter:image["'][^>]+content=["']([^"']+)["']/i) ||
          html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+name=["']twitter:image["']/i);
      url = m ? m[1] : null;
    }

    if (!url) { cacheSet(link, null); return null; }

    try { url = new URL(url, link).toString(); } catch {}
    url = normalizeHttps(url);

    cacheSet(link, url);
    return url;
  } catch {
    cacheSet(link, null);
    return null;
  }
}

/* ---------- route ---------- */
router.post("/", async (req, res) => {
  try {
    if (!SERP) return res.status(400).json({ ok:false, error:"Missing SERPAPI_API_KEY" });

    const body        = req.body || {};
    const categories  = (body.categories || []).map(clean).filter(Boolean);
    const allergensIn = (body.allergens || []).map(clean).filter(Boolean);
    const ratingFloor = Number(body.rating_floor ?? 4.0);
    const preferred   = (body.purchase_sites || []).map(s => s.toLowerCase());
    const priceMin    = (body.price_min ?? null) === null ? null : Number(body.price_min);
    const priceMax    = (body.price_max ?? null) === null ? null : Number(body.price_max);
    const locationRaw = clean(body.location || "");

    const locationCanonical = await resolveLocationCanonical(locationRaw);
    const allergens = expandAllergens(allergensIn);
    const results = [];

    for (const cat of categories) {
      const q1 = `${cat} fragrance free`;
      const q2 = `${cat} site:(sephora.com OR ulta.com OR target.com OR amazon.com)`;

      let data = await serpShopping(q1, locationCanonical || locationRaw);
      let items = (data.shopping_results || []).map(mapShoppingItem);

      if (!items.length) {
        await sleep(600);
        data = await serpShopping(q2, locationCanonical || locationRaw);
        items = (data.shopping_results || []).map(mapShoppingItem);
      }

      const kept = [];
      for (const it of items) {
        // rating
        if ((it.rating ?? 5) < ratingFloor) continue;

        // price (skip items without price if a bound is set)
        const hasPrice = typeof it.price === "number" && !Number.isNaN(it.price);
        if ((priceMin !== null || priceMax !== null) && !hasPrice) continue;
        if (priceMin !== null && it.price < priceMin) continue;
        if (priceMax !== null && it.price > priceMax) continue;

        // ingredients
        const inci = await fetchIngredients(it.link);
        if (containsAllergen(inci, allergens)) continue;

        const d = host(it.link).toLowerCase();
        const isPreferred = preferred.some(p => d.includes(p));

        kept.push({
          name: it.name,
          rating: it.rating,
          reviews: it.reviews,
          price: it.price,
          links: {
            primary: it.link,
            manufacturer: (it.brand && d.includes(it.brand.toLowerCase().replace(/\s+/g,""))) ? it.link : undefined
          },
          source: it.source,
          thumbnail: it.thumbnail,
          priority: isPreferred ? 2 : 0
        });

        if (kept.length >= 8) break;
        await sleep(200);
      }

      kept.sort((a,b) => (b.priority - a.priority) || ((b.rating||0)-(a.rating||0)));

      const enriched = await Promise.all(kept.map(async (it) => {
        const image = await resolveImageForItem(it);
        const { thumbnail, priority, ...rest } = it;
        return { ...rest, image: image || undefined };
      }));

      results.push({ category: cat, items: enriched });
      await sleep(500);
    }

    res.json({
      ok: true,
      results,
      message:
        `Screened against (${allergens.join(", ") || "none"})` +
        ((priceMin!==null||priceMax!==null) ? ` with price filter${priceMin!==null?` ≥ $${priceMin}`:""}${priceMax!==null?` ≤ $${priceMax}`:""}` : "") +
        (locationCanonical ? ` • Location: ${locationCanonical}` : (locationRaw ? ` • Location: ${locationRaw}` : ""))
    });

  } catch (err) {
    console.error(err);
    res.status(500).json({ ok:false, error:"Search failed", detail:String(err) });
  }
});

export default router;
