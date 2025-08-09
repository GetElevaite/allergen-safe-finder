import express from "express";

const router = express.Router();
const SERP = process.env.SERPAPI_API_KEY;

// --- helpers -------------------------------------------------
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const clean = (s="") => String(s || "").trim();
const host = (u="") => { try { return new URL(u).hostname.replace(/^www\./,""); } catch { return ""; } };

// minimal synonyms / cross-reactors (expand later)
const synonyms = {
  "benzophenone-3": ["oxybenzone","bp-3","benzophenone 3","bp3","benzophenone-4","bp-4"],
  "amidoamine": ["stearamidopropyl dimethylamine","sda","amidopropyl"],
  "propolis": ["bee glue","propolis extract","cera","beeswax"],
  "sorbitan sesquioleate": ["sso","sorbitan sesqui oleate"]
};

// merge user allergens + synonyms
function expandAllergens(list=[]) {
  const out = new Set();
  for (const a of list) {
    const k = a.toLowerCase().trim();
    out.add(k);
    (synonyms[k] || []).forEach(x => out.add(x));
  }
  return [...out];
}

async function serpShopping(q){
  const url = new URL("https://serpapi.com/search.json");
  url.searchParams.set("engine","google_shopping");
  url.searchParams.set("q", q);
  url.searchParams.set("gl","us");
  url.searchParams.set("hl","en");
  url.searchParams.set("num","12");
  url.searchParams.set("api_key", SERP);
  const r = await fetch(url, { timeout: 20000 });
  if (!r.ok) throw new Error("SerpAPI error " + r.status);
  return r.json();
}

// fetch product page server-side and try to extract an INCI/ingredients block
async function fetchIngredients(url){
  try{
    const r = await fetch(url, { timeout: 20000, redirect: "follow" });
    const html = (await r.text()).toLowerCase();

    // crude extraction near “ingredient”
    const idx = html.indexOf("ingredient");
    if (idx === -1) return { text: "", ok: true };

    const slice = html.slice(Math.max(0, idx - 800), idx + 2000);
    // remove markup
    const text = slice.replace(/<[^>]+>/g," ").replace(/\s+/g," ").trim();
    return { text, ok: true };
  }catch{
    return { text:"", ok:false };
  }
}

function mapItem(x){
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

// --- route ---------------------------------------------------
router.post("/", async (req, res) => {
  try{
    if (!SERP) return res.status(400).json({ ok:false, error:"Missing SERPAPI_API_KEY" });

    const body = req.body || {};
    const categories = (body.categories || []).map(clean).filter(Boolean);
    const allergensRaw = (body.allergens || []).map(clean).filter(Boolean);
    const ratingFloor = Number(body.rating_floor ?? 4.0);
    const preferred = (body.purchase_sites || []).map(s => s.toLowerCase());

    const allergens = expandAllergens(allergensRaw);

    const results = [];

    for (const cat of categories){
      // 1) broader query first to avoid zero-results
      const q1 = `${cat} fragrance free`;
      // 2) fallback focused on major beauty retailers if needed
      const q2 = `${cat} site:(sephora.com OR ulta.com OR target.com OR amazon.com)`;

      let data = await serpShopping(q1);
      let items = (data.shopping_results || []).map(mapItem);

      if (!items.length){
        await sleep(600);
        data = await serpShopping(q2);
        items = (data.shopping_results || []).map(mapItem);
      }

      // filter by rating, then screen ingredients on manufacturer/retailer page
      const kept = [];
      for (const it of items){
        if ((it.rating ?? 5) < ratingFloor) continue;

        const { text } = await fetchIngredients(it.link);
        const hit = allergens.some(a => text.includes(a));
        if (hit) continue; // drop if allergen appears

        // promote preferred domains first
        const d = host(it.link).toLowerCase();
        it.priority = preferred.some(p => d.includes(p)) ? 1 : 0;

        // build link set for UI
        it.links = {
          primary: it.link,
          manufacturer: (it.brand && d.includes(it.brand.toLowerCase().replace(/\s+/g,""))) ? it.link : undefined
        };

        kept.push(it);
        if (kept.length >= 6) break; // keep it tight
        await sleep(250);            // polite
      }

      // order by priority (preferred sites first), then rating
      kept.sort((a,b) => (b.priority - a.priority) || ((b.rating||0)-(a.rating||0)));

      results.push({
        category: cat,
        items: kept.map(k => ({
          name: k.name,
          rating: k.rating,
          reviews: k.reviews,
          price: k.price,
          links: {
            manufacturer: k.links.manufacturer,
            primary: k.links.primary
          },
          source: k.source
        }))
      });

      await sleep(600);
    }

    res.json({
      ok: true,
      results,
      message: `Screened against: ${allergens.join(", ") || "none provided"}.`
    });

  }catch(err){
    console.error(err);
    res.status(500).json({ ok:false, error:"Search failed", detail:String(err) });
  }
});

export default router;
