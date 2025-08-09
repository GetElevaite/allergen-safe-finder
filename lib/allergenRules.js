export const KNOWN_ALLERGENS = [
  "Amidoamine",
  "Propolis",
  "Benzophenone-3",
  "Oxybenzone",
  "Sorbitan sesquioleate",
  "Fragrance Mix 1",
  "Fragrance Mix 2",
  "Amerchol"
];

export function buildCrossReactors(selected) {
  const watchlist = new Set();
  const has = (name) => selected.map(s => s.toLowerCase()).includes(name.toLowerCase());

  if (has("Benzophenone-3") || has("Oxybenzone")) {
    ["Benzophenone-1","Benzophenone-2","Benzophenone-4","Sulisobenzone","Oxybenzone"].forEach(x => watchlist.add(x));
  }
  if (has("Fragrance Mix 1") || has("Fragrance Mix 2")) {
    ["Fragrance","Parfum","Essential oil"].forEach(x => watchlist.add(x));
  }
  if (has("Amidoamine")) {
    ["Cocamidopropyl Betaine","CAPB","Amidoamine"].forEach(x => watchlist.add(x));
  }
  if (has("Amerchol")) {
    ["Lanolin","Lanolin Alcohol","Cholesterol"].forEach(x => watchlist.add(x));
  }
  if (has("Propolis")) {
    ["Propolis Extract","Bee Propolis","Cera Propolis"].forEach(x => watchlist.add(x));
  }
  if (has("Sorbitan sesquioleate")) {
    ["Sorbitan","Polysorbate"].forEach(x => watchlist.add(x));
  }
  return Array.from(watchlist);
}

export function enforcePolicyOnItem(item, allergens, watchlist) {
  const incis = (item.inci || []).map(x => (x||'').toLowerCase());
  const contains = (needle) => incis.some(x => x.includes(needle.toLowerCase()));

  for (const a of allergens) {
    if (contains(a)) return { ok:false, reason:`Contains listed allergen: ${a}` };
  }
  for (const w of watchlist) {
    if (contains(w)) return { ok:false, reason:`Potential cross-reactor present: ${w}` };
  }
  return { ok:true };
}
