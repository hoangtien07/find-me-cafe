/**
 * Filter an Overture Maps GeoJSON-seq dump to the drink-venue spine and emit
 * the NDJSON dialect ingest-venues-jsonl.ts understands (one feature/line).
 *
 *   node scripts/overture-to-jsonl.mjs places.geojson > venues.jsonl
 *
 * Keep rule: taxonomy.hierarchy[1] is the drink bucket (the 2026 schema's
 * reliable level — leaf cats shift between releases), OR the primary leaf
 * category is a drink leaf for releases still using categories.primary.
 */
import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';

const DRINK_PARENTS = new Set(['non_alcoholic_beverage_venue', 'alcoholic_beverage_venue']);
const DRINK_LEAVES = new Set([
  'cafe', 'coffee_shop', 'coffee_roaster', 'espresso_bar', 'internet_cafe',
  'cat_cafe', 'pet_cafe',
  'tea_house', 'tea_shop', 'bubble_tea_shop', 'milk_bar',
  'juice_bar', 'juice_shop', 'smoothie_juice_bar',
  'dessert_shop', 'ice_cream_parlor', 'confectionery', 'bakery',
  'bar', 'pub', 'cocktail_bar', 'wine_bar', 'sports_bar', 'karaoke_bar',
  'night_club', 'hookah_lounge', 'lounge',
  'beer_garden', 'brewpub', 'beer_hall',
]);

const file = process.argv[2];
if (!file) {
  console.error('usage: node scripts/overture-to-jsonl.mjs <places.geojson>');
  process.exit(1);
}

const rl = createInterface({ input: createReadStream(file), crlfDelay: Infinity });
let n = 0;
let kept = 0;
for await (const line of rl) {
  if (!line.trim()) continue;
  n++;
  let f;
  try {
    f = JSON.parse(line);
  } catch {
    continue;
  }
  const p = f && typeof f === 'object' ? f.properties : null;
  if (!p || typeof p !== 'object') continue;
  const taxonomy = p.taxonomy && typeof p.taxonomy === 'object' ? p.taxonomy : {};
  const hierarchy = Array.isArray(taxonomy.hierarchy) ? taxonomy.hierarchy : [];
  const leaf =
    (typeof p.basic_category === 'string' && p.basic_category) ||
    (p.categories && typeof p.categories === 'object' && typeof p.categories.primary === 'string'
      ? p.categories.primary
      : null);
  if (DRINK_PARENTS.has(hierarchy[1]) || (leaf && DRINK_LEAVES.has(leaf))) {
    kept++;
    process.stdout.write(line.trim() + '\n');
  }
}
console.error(`[overture] ${n} features in, ${kept} drink venues kept`);
