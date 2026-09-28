/**
 * Ingest a scraped/provider JSONL file into the venues store.
 *
 *   npx tsx scripts/ingest-venues-jsonl.ts <file.jsonl> [--source google_scrape] [--license google_scrape_internal]
 *
 * Each line becomes an append-only `venue_observations` row (raw payload +
 * license tag) merged into a canonical `venues` row via the same matching
 * the live app uses. Booting `../src/db/database` runs schema + migrations,
 * so the tables exist before the first row lands.
 *
 * Progress prints every 500 rows; the whole run is resumable by external_id —
 * a re-ingest of the same file merges instead of duplicating.
 */
import { createReadStream } from 'fs';
import { createInterface } from 'readline';
import { db } from '../src/db/database';
import { DatabaseService } from '../src/nest/database/database.service';
import { VenuesRepository } from '../src/nest/venues/venues.repository';
import { VenuesService, fieldsFromGoogleScrape } from '../src/nest/venues/venues.service';
import type { VenueFields } from '../src/nest/venues/venues.types';

const args = process.argv.slice(2);
const file = args.find((a) => !a.startsWith('--'));
const opt = (name: string, dflt: string): string => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : dflt;
};

if (!file) {
  console.error('usage: tsx scripts/ingest-venues-jsonl.ts <file.jsonl> [--source X] [--license Y]');
  process.exit(1);
}

const source = opt('source', 'google_scrape');
const license = opt('license', 'google_scrape_internal');

const service = new VenuesService(new VenuesRepository(new DatabaseService(db)));

/** TrackAsia/Google-compat rows differ; extend extractors here as new
 *  sources land. The scraped `raw.jsonl` dialect is the only one today. */
function extract(source: string, row: Record<string, unknown>): VenueFields {
  switch (source) {
    case 'google_scrape':
    default:
      return fieldsFromGoogleScrape(row);
  }
}

function externalId(source: string, row: Record<string, unknown>): string | null {
  for (const k of ['place_id', 'cid', 'data_id', 'id', 'ref_id']) {
    const v = row[k];
    if (typeof v === 'string' && v.trim()) return v.trim();
    if (typeof v === 'number') return String(v);
  }
  return null;
}

async function main(): Promise<void> {
  const rl = createInterface({ input: createReadStream(file!), crlfDelay: Infinity });
  let n = 0, ok = 0, merged = 0, skipped = 0;
  const started = Date.now();
  for await (const line of rl) {
    n++;
    if (!line.trim()) continue;
    let row: Record<string, unknown>;
    try {
      row = JSON.parse(line) as Record<string, unknown>;
    } catch {
      skipped++;
      continue;
    }
    const extId = externalId(source, row);
    if (!extId) {
      skipped++;
      continue;
    }
    try {
      const res = service.ingest(
        {
          source,
          externalId: extId,
          externalRefs: {
            place_id: row.place_id ?? null,
            cid: row.cid ?? null,
            data_id: row.data_id ?? null,
            link: row.link ?? null,
          },
          payload: row,
          licenseTag: license,
          fetchedAt: Date.now(),
        },
        extract(source, row),
      );
      if (res.venueId > 0) {
        ok++;
        if (res.matched !== 'new') merged++;
      } else skipped++;
    } catch (err) {
      skipped++;
      if (skipped <= 5) console.error(`[ingest] row ${n} failed:`, (err as Error).message);
    }
    if (n % 500 === 0) console.log(`[ingest] ${n} rows — ${ok} venues (${merged} merged, ${skipped} skipped)`);
  }
  console.log(`[ingest] DONE ${n} rows in ${((Date.now() - started) / 1000).toFixed(1)}s — ${ok} venues (${merged} merged, ${skipped} skipped); total venues=${service.count()}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
