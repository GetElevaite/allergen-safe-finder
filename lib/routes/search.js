import express from "express";
const router = express.Router();

// Accept POSTs from the form and return demo results
router.post("/", (req, res) => {
  const { allergens = [], categories = [] } = req.body || {};

  const results = (categories || []).map((cat) => ({
    category: cat,
    items: [
      {
        name: "Demo " + cat + " — Fragrance-Free Example",
        variant: "30 ml",
        rating: 4.6,
        reviews: 1200,
        links: {
          manufacturer: "https://example.com/" + encodeURIComponent(cat),
          retailer1: "https://www.target.com/",
          retailer2: "https://www.amazon.com/",
        },
        policy: { ok: true }
      }
    ]
  }));

  const message =
    `Results for ${categories.join(", ") || "your categories"}.\n` +
    `Excluded allergens: ${allergens.join(", ") || "none listed"}.\n\n` +
    `These recommendations are for informational purposes only and are not a substitute for medical advice. ` +
    `Please consult a qualified healthcare provider before trying new products.`;

  res.json({ ok: true, results, message, watchlist: [] });
});

export default router;
