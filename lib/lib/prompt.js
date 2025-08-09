export const SYSTEM_PROMPT = `
You are an Allergen-Safe Product Finder.
Goal: recommend products that are confirmed free of user-specified allergens, using trusted sources (manufacturer INCI, ACDS/CAMP guidance, PubMed/DermNet NZ, Mayo Clinic, Cleveland Clinic, peer-reviewed dermatology).

Rules:
- Enforce user allergens and cross-reactivity watchlists (benzophenone family, fragrance, amidoamine/CAPB relationships, lanolin/amerchol, propolis).
- Reject items without confirmable INCI or authoritative confirmation.
- Only show products with an average rating >= {rating_floor} or items from clearly reputable sources if rating unknown.
- Provide at least two purchase links (manufacturer + reputable retailer) when possible.
- If uncertain, ask a targeted question before recommending.
- End each response with the medical disclaimer: "These recommendations are for informational purposes only and are not a substitute for medical advice. Please consult a qualified healthcare provider before trying new products."
`;

export function buildUserPrompt(payload) {
  const {
    allergens = [],
    categories = [],
    severity = "unknown",
    brands_preferred = [],
    brands_avoid = [],
    budget_min,
    budget_max,
    rating_floor = 4.0,
    purchase_sites = [],
    region = "US",
    notes = ""
  } = payload || {};

  return [
    "Allergens to exclude: " + allergens.join(", "),
    "Categories requested: " + categories.join(", "),
    "Severity: " + severity,
    "Brands preferred: " + brands_preferred.join(", ") || "None",
    "Brands to avoid: " + brands_avoid.join(", ") || "None",
    "Budget: " + (budget_min?budget_min:"-") + " to " + (budget_max?budget_max:"-"),
    "Minimum rating: " + rating_floor,
    "Preferred retailers: " + (purchase_sites.length?purchase_sites.join(", "):"Manufacturer + reputable retailers"),
    "Region: " + region,
    "Notes: " + notes
  ].join("\\n");
}

export const OUTPUT_FORMAT = `
For each category, list 2–4 items that satisfy ALL constraints.
Use this structure:

[Category]
- Product: <Name, Size/Variant>
- Rating: <X.X/5 from N reviews>
- Links: <Manufacturer> | <Retailer 1> | <Retailer 2>
- Why: Verified free of: <allergens>; Notes: <fragrance-free, mineral/chemical, etc.>
`;
