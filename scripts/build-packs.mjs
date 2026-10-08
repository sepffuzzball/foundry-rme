#!/usr/bin/env node
// build-packs.mjs
//
// Deterministically compiles the RME catalog into three Foundry dnd5e Item
// compendium packs (Weapons, Armor, Shields) as LevelDB directories under
// packs/. The per-item JSON sources are written under the ignored packs-src/
// directory and compiled with @foundryvtt/foundryvtt-cli's compilePack.
//
// Interface:
//   npm run build:packs
//
// For every catalog entry the script:
//   1. Derives a stable 16-character alphanumeric Foundry document id:
//        _id  = sha256(entry.id).slice(0, 16)  (lowercase hex)
//        _key = `!items!${_id}`
//   2. Builds the item body from the existing makeItemData mapper at the
//      'untrained' level, without modifying it.
//   3. Ensures system.identifier is present (dnd5e expects it; the mapper does
//      not produce it). The value is the slugified item name, matching what the
//      dnd5e system would derive from the item name.
//
// Groups and counts (validated strictly; a mismatch fails the build):
//   weapons: kind weapon + kind natural       -> 153
//   armor:   kind armor                       -> 12
//   shields: kind shield                      -> 8
//   total:                                    -> 173
//
// All entries must be assigned exactly once and must produce unique ids; the
// build fails loudly rather than silently dropping a record.

import { readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { compilePack } from '@foundryvtt/foundryvtt-cli';

import { makeItemData } from '../src/items.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

const TOTAL_EXPECTED = 173;

// The three packs. `kinds` enumerates the catalog `kind` values that belong to
// each pack; `expected` is the strict count required for each.
const GROUPS = [
  { name: 'weapons', kinds: ['weapon', 'natural'], expected: 153 },
  { name: 'armor', kinds: ['armor'], expected: 12 },
  { name: 'shields', kinds: ['shield'], expected: 8 },
];

function fail(message) {
  throw new Error(`[build-packs] ${message}`);
}

function slugify(str) {
  return String(str)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

// Stable, Foundry-compatible 16-character document id. This is intentionally
// derived only from the catalog id so re-runs are byte-for-byte identical.
function stableId(entryId) {
  return createHash('sha256').update(entryId, 'utf8').digest('hex').slice(0, 16);
}

// Build one pack source document (JSON-serializable) for a catalog entry.
function itemDocument(entry) {
  const data = makeItemData(entry, 'untrained');
  const id = stableId(entry.id);

  const doc = {
    _id: id,
    _key: `!items!${id}`,
    name: data.name,
    type: data.type,
    system: data.system,
    flags: data.flags,
  };

  // dnd5e items carry system.identifier. The makeItemData mapper does not set
  // it, and it is required for the item to be considered identified and to
  // participate in the compendium browser. We do not change the mapper; we
  // only fill in this field at pack-build time.
  if (!doc.system.identifier) {
    doc.system.identifier = slugify(entry.name);
  }

  return doc;
}

// Builds the three compendium packs. Returns a summary for logging/tests.
export async function buildPacks({ root = ROOT } = {}) {
  const catalogPath = join(root, 'data', 'catalog.json');
  const packsSrc = join(root, 'packs-src');
  const packs = join(root, 'packs');

  const catalog = JSON.parse(readFileSync(catalogPath, 'utf8'));
  const equipment = catalog.equipment;
  if (!Array.isArray(equipment)) {
    fail('catalog.equipment must be an array');
  }
  if (equipment.length !== TOTAL_EXPECTED) {
    fail(`expected ${TOTAL_EXPECTED} equipment entries, got ${equipment.length}`);
  }

  // Assign entries to their group, deterministically sorted by id.
  const groups = GROUPS.map((g) => ({
    ...g,
    entries: equipment
      .filter((e) => g.kinds.includes(e.kind))
      .sort((a, b) => a.id.localeCompare(b.id)),
  }));

  // Strict counts and full coverage: every catalog entry must land in exactly
  // one group, at the exact expected count, with no silent drops.
  const seen = new Set();
  for (const g of groups) {
    if (g.entries.length !== g.expected) {
      fail(
        `group ${g.name}: expected ${g.expected} entries, got ${g.entries.length} ` +
          `(kinds ${g.kinds.join('+')})`
      );
    }
    for (const e of g.entries) {
      if (seen.has(e.id)) {
        fail(`entry ${e.id} was assigned to more than one pack`);
      }
      seen.add(e.id);
    }
  }
  if (seen.size !== equipment.length) {
    fail(
      `only ${seen.size}/${equipment.length} catalog entries were assigned to a pack`
    );
  }

  // Unique generated ids across all packs.
  const usedIds = new Set();
  for (const g of groups) {
    for (const e of g.entries) {
      const id = stableId(e.id);
      if (usedIds.has(id)) {
        fail(`generated duplicate item id ${id} for ${e.id}`);
      }
      usedIds.add(id);
    }
  }

  // Rebuild the source tree and compile each pack.
  rmSync(packsSrc, { recursive: true, force: true });
  const compiled = [];
  for (const g of groups) {
    const srcDir = join(packsSrc, g.name);
    mkdirSync(srcDir, { recursive: true });
    for (const e of g.entries) {
      const doc = itemDocument(e);
      writeFileSync(
        join(srcDir, `${doc._id}.json`),
        `${JSON.stringify(doc, null, 2)}\n`,
        'utf8'
      );
    }

    const dest = join(packs, g.name);
    rmSync(dest, { recursive: true, force: true });
    await compilePack(srcDir, dest, { log: false });
    compiled.push({ name: g.name, count: g.entries.length, dest: `packs/${g.name}` });
  }

  return { total: seen.size, groups: compiled };
}

const isMain =
  process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  buildPacks()
    .then((summary) => {
      for (const g of summary.groups) {
        console.log(`compiled ${g.name}: ${g.count} items -> ${g.dest}`);
      }
      console.log(`total: ${summary.total} items`);
    })
    .catch((err) => {
      console.error(err.message || err);
      process.exitCode = 1;
    });
}
