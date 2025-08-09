import express from "express";
import { config } from "dotenv";
import OpenAI from "openai";
import { SYSTEM_PROMPT, buildUserPrompt, OUTPUT_FORMAT } from "../lib/prompt.js";
import { buildCrossReactors, enforcePolicyOnItem } from "../lib/allergenRules.js";

config();
const router = express.Router();
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// Mock candidate products (replace with real API integrations later)
async function fetchCandidateProducts(categories) {
  const demo = [];
  for (const cat of categories) {
    demo.push({
      category: cat,
      items: [
        {
          name: "Demo " + cat + " — Fragrance-Free Example",
          variant: "50 ml",
          rating: 4.6,
          reviews: 1245,
          inci: ["Aqua", "Zinc Oxide", "Glycerin", "Dimethicone", "Butyrospermum Parkii Butter"],
          links: {
            manufacturer: "https://example.com/" + encodeURIComponent(cat),
            retailer1: "https://www.target.com/",
            retailer2: "https://www.amazon.com/"
          }
        },
        {
          name: "Demo " + cat + " — Mineral Base",
          variant: "100 ml",
          rating: 4.4,
          reviews: 782,
          inci: ["Aqua", "Titanium Dioxide", "Caprylic/Capric Triglyceride", "Squalane"],
          links: {
            manufacturer: "https://example.com/" + encodeURIComponent(cat) + "/mineral",
            retailer1: "https://www.ulta.com/",
            retailer2: "https://www.sephora.com/"
          }
        }
      ]
    });
  }
  return demo;
}

router.post("/", async (req, res) => {
  try {
    const payload = req.body || {};
    const ratingFloor = Number(payload.rating_floor || process.env.RATING_FLOOR || 4.0);
    const allergens = Array.isArray(payload.allergens) ? payload.allergens : [];
    const categories = Array.isArray(payload.categories) ? payload.categories : [];

    if (!process.env.OPENAI_API_KEY) {
      return res.status(400).json({ error: "Missing OPENAI_API_KEY" });
    }
    if (!allergens.length || !categories.length) {
      return res.status(400).json({ error: "allergens[] and categories[] are required" });
    }

    const watchlist = buildCrossReactors(allergens);
    const candidates = await fetchCandidateProducts(categories);

    const results = candidates.map(group => {
      const filtered = (group.items || [])
        .filter(x => (x.rating || 0) >= ratingFloor)
        .map(item => {
          const policy = enforcePolicyOnItem(item, allergens, watchlist);
          return { ...item, policy };
        })
        .filter(x => x.policy.ok);

      return { category: group.category, items: filtered.slice(0, 4) };
    });

    const sys = SYSTEM_PROMPT.replace("{rating_floor}", String(ratingFloor));
    const userPrompt = buildUserPrompt(payload);
    const modelInput = [
      { role: "system", content: sys },
      { role: "user", content: userPrompt },
      { role: "user", content: "Format:\n" + OUTPUT_FORMAT },
      { role: "user", content: "Proposed items (machine): " + JSON.stringify(results, null, 2) }
    ];

    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: modelInput,
      temperature: 0.2
    });

    const text = completion?.choices?.[0]?.message?.content || "";
    res.json({ ok: true, results, message: text, watchlist });

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server error", detail: String(err) });
  }
});

export default router;
