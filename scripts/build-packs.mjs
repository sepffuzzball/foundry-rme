#!/usr/bin/env node
// build-packs.mjs
//
// Deterministically compiles the RME catalog into four Foundry dnd5e Item
// compendium packs (Weapons, Armor, Shields, Ammunition) as LevelDB
// directories under packs/. The per-item JSON sources are written under the
// ignored packs-src/ directory and compiled with @foundryvtt/foundryvtt-cli's
// compilePack.
//
// Interface:
//   npm run build:packs
//
// For the three equipment packs (Weapons, Armor, Shields) the script:
//   1. Derives a stable 16-character alphanumeric Foundry document id:
//        _id  = sha256(entry.id).slice(0, 16)  (lowercase hex)
//        _key = `!items!${_id}`
//   2. Builds the item body from the existing makeItemData mapper at the
//      'untrained' level, without modifying it.
//   3. Ensures system.identifier is present (dnd5e expects it; the mapper does
//      not produce it). The value is the slugified item name, matching what the
//      dnd5e system would derive from the item name.
//
// The fourth pack (Ammunition) is compiled from data/ammunition.json rather
// than the equipment catalog. Each entry is a stack of consumable ammunition:
//   _id  = sha256(`ammo/${entry.id}`).slice(0, 16)  (lowercase hex)
//   _key = `!items!${_id}`
// It carries the dnd5e consumable fields explicitly (type 'consumable',
// system.type {value:'ammo', subtype:'rme-<family>'}, system.quantity, a zero
// weight, and a per-unit price so a full stack matches the user-specified
// stack cost). No tactical effects are implemented in this step; the
// foundry-rme flag block records the ammo id, family, stack cost, and the
// declarative effect metadata.
//
// Groups and counts (validated strictly; a mismatch fails the build):
//   weapons:    kind weapon + kind natural -> 153
//   armor:      kind armor                 -> 12
//   shields:    kind shield                -> 8
//   ammunition: data/ammunition.json       -> 25
//   total:                                 -> 198
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
const AMMO_EXPECTED = 25;

// The three equipment packs. `kinds` enumerates the catalog `kind` values that
// belong to each pack; `expected` is the strict count required for each.
const GROUPS = [
  { name: 'weapons', kinds: ['weapon', 'natural'], expected: 153 },
  { name: 'armor', kinds: ['armor'], expected: 12 },
  { name: 'shields', kinds: ['shield'], expected: 8 },
];

// The fourth pack is compiled from data/ammunition.json, not the catalog.
const AMMO_PACK = { name: 'ammunition', expected: AMMO_EXPECTED };

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

// Ammunition document ids are namespaced with `ammo/` so they can never
// collide with the catalog-derived equipment ids.
function ammoId(entryId) {
  return createHash('sha256').update(`ammo/${entryId}`, 'utf8').digest('hex').slice(0, 16);
}

// Escape HTML so the ammo description renders as literal text (never injected).
function escapeHtml(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// The ammo description is plain explanatory text wrapped in a <pre> block so it
// renders literally, matching the equipment pack convention.
function ammoDescription(text) {
  return `<pre>${escapeHtml(text)}</pre>`;
}

// Build one ammunition pack source document from a data/ammunition.json entry.
// Consumable ammunition carries dnd5e fields explicitly: type 'consumable',
// system.type {value:'ammo', subtype:'rme-<family>'}, a stack quantity, a zero
// weight, and a per-unit price (stackCostGp / quantity) so the whole stack
// matches the user-specified stack cost. No tactical effects are implemented in
// this step; the flags block records the declarative effect metadata only.
function ammoDocument(entry) {
  const id = ammoId(entry.id);
  const unitPrice = entry.stackCostGp / entry.quantity;

  const doc = {
    _id: id,
    _key: `!items!${id}`,
    name: entry.name,
    type: 'consumable',
    system: {
      type: { value: 'ammo', subtype: `rme-${entry.family}` },
      quantity: entry.quantity,
      weight: { value: 0, units: 'lb' },
      price: { value: unitPrice, denomination: 'gp' },
      description: { value: ammoDescription(entry.description) },
    },
    flags: {
      'foundry-rme': {
        ammoId: entry.id,
        family: entry.family,
        stackCostGp: entry.stackCostGp,
        effect: entry.effect,
      },
    },
  };

  // dnd5e items carry system.identifier. The data source does not set it, and
  // it is required for the item to be considered identified and to participate
  // in the compendium browser. We only fill it here, never in the source data.
  if (!doc.system.identifier) {
    doc.system.identifier = slugify(entry.name);
  }

  return doc;
}

// Validate one data/ammunition.json entry has every field the build relies on.
function validateAmmoEntry(entry, index) {
  const label = entry?.id || `entry #${index}`;
  if (typeof entry.id !== 'string' || entry.id.length === 0) {
    fail(`ammunition entry ${label} must have a non-empty string id`);
  }
  if (typeof entry.name !== 'string' || entry.name.length === 0) {
    fail(`ammunition entry ${label} must have a non-empty string name`);
  }
  if (typeof entry.family !== 'string' || entry.family.length === 0) {
    fail(`ammunition entry ${label} must have a non-empty string family`);
  }
  if (typeof entry.stackCostGp !== 'number' || !Number.isFinite(entry.stackCostGp)) {
    fail(`ammunition entry ${label} must have a numeric stackCostGp`);
  }
  if (typeof entry.quantity !== 'number' || entry.quantity <= 0) {
    fail(`ammunition entry ${label} must have a positive numeric quantity`);
  }
  if (typeof entry.description !== 'string' || entry.description.length === 0) {
    fail(`ammunition entry ${label} must have a non-empty string description`);
  }
  if (!entry.effect || typeof entry.effect !== 'object' || typeof entry.effect.text !== 'string' || entry.effect.text.length === 0) {
    fail(`ammunition entry ${label} must declare an effect object with a non-empty text`);
  }
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

// Builds the four compendium packs (Weapons, Armor, Shields, Ammunition).
// Returns a summary for logging/tests.
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

  // Rebuild the source tree and compile each equipment pack.
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

  // Build the ammunition pack from data/ammunition.json. It is a separate data
  // source, kept out of the equipment catalog so the 173 equipment count and the
  // three equipment packs are untouched.
  const ammoPath = join(root, 'data', 'ammunition.json');
  let ammoEntries;
  try {
    ammoEntries = JSON.parse(readFileSync(ammoPath, 'utf8')).ammunition;
  } catch {
    fail('data/ammunition.json is not valid JSON');
  }
  if (!Array.isArray(ammoEntries)) {
    fail('data/ammunition.json must carry an ammunition array');
  }
  if (ammoEntries.length !== AMMO_PACK.expected) {
    fail(`expected ${AMMO_PACK.expected} ammunition entries, got ${ammoEntries.length}`);
  }
  ammoEntries.forEach(validateAmmoEntry);

  const ammoSrcDir = join(packsSrc, AMMO_PACK.name);
  mkdirSync(ammoSrcDir, { recursive: true });
  const ammoDocs = [];
  for (const entry of ammoEntries) {
    const doc = ammoDocument(entry);
    if (usedIds.has(doc._id)) {
      fail(`generated duplicate item id ${doc._id} for ${entry.id}`);
    }
    usedIds.add(doc._id);
    writeFileSync(
      join(ammoSrcDir, `${doc._id}.json`),
      `${JSON.stringify(doc, null, 2)}\n`,
      'utf8'
    );
    ammoDocs.push(doc);
  }

  const ammoDest = join(packs, AMMO_PACK.name);
  rmSync(ammoDest, { recursive: true, force: true });
  await compilePack(ammoSrcDir, ammoDest, { log: false });
  compiled.push({
    name: AMMO_PACK.name,
    count: ammoDocs.length,
    dest: `packs/${AMMO_PACK.name}`,
  });

  // Total is the sum of every pack, equipment and ammunition.
  const total = compiled.reduce((sum, g) => sum + g.count, 0);
  return { total, groups: compiled };
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
