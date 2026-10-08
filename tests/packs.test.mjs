import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

import { extractPack } from '@foundryvtt/foundryvtt-cli';
import { buildPacks } from '../scripts/build-packs.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const MANIFEST_PATH = join(ROOT, 'module.json');

// The exact pack layout produced by build:packs.
const PACKS = [
  { name: 'weapons', path: 'packs/weapons', expected: 153, kinds: ['weapon', 'natural'] },
  { name: 'armor', path: 'packs/armor', expected: 12, kinds: ['armor'] },
  { name: 'shields', path: 'packs/shields', expected: 8, kinds: ['shield'] },
];

const TOTAL_EXPECTED = 173;

const catalog = JSON.parse(
  readFileSync(join(ROOT, 'data', 'catalog.json'), 'utf8')
);
const equipmentById = new Map(catalog.equipment.map((e) => [e.id, e]));
assert.equal(catalog.equipment.length, TOTAL_EXPECTED, 'catalog must contain all 173 items');

// Deterministic slug used to derive system.identifier (matches the build script).
function slugify(str) {
  return String(str)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function stableId(entryId) {
  return createHash('sha256').update(entryId, 'utf8').digest('hex').slice(0, 16);
}

// Build the packs exactly the way `npm run build:packs` does, then extract each
// pack back out of the compiled LevelDB pack and return every document.
async function buildAndExtract() {
  const summary = await buildPacks({ root: ROOT });
  assert.equal(summary.total, TOTAL_EXPECTED, 'build must report all 173 items');
  for (const g of summary.groups) {
    assert.equal(typeof g.count, 'number', 'build must report a numeric count');
    assert.equal(typeof g.dest, 'string', 'build must report a pack path');
  }

  const allDocs = [];
  for (const pack of PACKS) {
    const tmp = mkdtempSync(join(tmpdir(), `rme-packs-${pack.name}-`));
    try {
      await extractPack(join(ROOT, pack.path), tmp, {});
      const files = readdirSync(tmp).filter((f) => f.endsWith('.json'));
      const docs = files.map((f) =>
        JSON.parse(readFileSync(join(tmp, f), 'utf8'))
      );
      for (const doc of docs) {
        allDocs.push({ pack: pack.name, doc });
      }
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  }
  return allDocs;
}

function assertValidItemSchema(doc, packName) {
  assert.equal(typeof doc._id, 'string', `${packName} item must have a string _id`);
  assert.match(doc._id, /^[0-9a-f]{16}$/, `${packName} item _id must be 16-char hex`);
  assert.equal(doc._key, `!items!${doc._id}`, `${packName} item _key must match its _id`);

  assert.equal(typeof doc.name, 'string', `${packName} item must have a name`);
  assert.ok(doc.name.length > 0, `${packName} item name must be non-empty`);
  assert.ok(
    doc.type === 'weapon' || doc.type === 'equipment',
    `${packName} item type must be weapon or equipment`
  );

  assert.ok(doc.system && typeof doc.system === 'object', `${packName} item must have system`);
  assert.ok(
    doc.system.description?.value?.startsWith('<pre>'),
    `${packName} item description must be wrapped in <pre>`
  );
  assert.ok(
    doc.system.description?.value?.endsWith('</pre>'),
    `${packName} item description must be wrapped in <pre>`
  );
  assert.equal(typeof doc.system.identifier, 'string', `${packName} item must have system.identifier`);
  assert.ok(doc.system.identifier.length > 0, `${packName} system.identifier must be non-empty`);
  assert.equal(
    doc.system.identifier,
    slugify(doc.name),
    `${packName} system.identifier must be the slugified item name`
  );

  assert.ok(doc.flags && typeof doc.flags === 'object', `${packName} item must have flags`);
  assert.ok(
    doc.flags['foundry-rme'] && typeof doc.flags['foundry-rme'] === 'object',
    `${packName} item must carry the foundry-rme flag block`
  );
}

test('build:packs produces exactly three compendium packs with the expected counts', async () => {
  const built = await buildPacks({ root: ROOT });
  assert.equal(built.total, TOTAL_EXPECTED, 'all catalog entries must be packed');

  const byName = new Map(built.groups.map((g) => [g.name, g.count]));
  assert.equal(byName.size, PACKS.length, 'exactly three packs must be compiled');

  for (const pack of PACKS) {
    assert.equal(
      byName.get(pack.name),
      pack.expected,
      `${pack.name} pack count must be ${pack.expected}`
    );
    assert.ok(
      built.groups.some((g) => g.name === pack.name && g.dest === pack.path),
      `${pack.name} must compile to ${pack.path}`
    );
  }
});

test('all 173 items survive a compile/extract round-trip with valid IDs and schema', async () => {
  const extracted = await buildAndExtract();
  assert.equal(extracted.length, TOTAL_EXPECTED, 'must extract all 173 items');

  const byPack = new Map();
  for (const { pack, doc } of extracted) {
    assertValidItemSchema(doc, pack);
    byPack.set(pack, (byPack.get(pack) || 0) + 1);
  }

  for (const pack of PACKS) {
    assert.equal(byPack.get(pack.name), pack.expected, `${pack.name} must extract exactly ${pack.expected} items`);
  }
});

test('every extracted item preserves its original catalogId with unique, stable ids', async () => {
  const extracted = await buildAndExtract();

  const catalogIds = new Set();
  const generatedIds = new Set();
  const byPack = new Map();

  for (const { pack, doc } of extracted) {
    const flags = doc.flags['foundry-rme'];
    const catalogId = flags.catalogId;
    assert.ok(
      equipmentById.has(catalogId),
      `catalogId ${catalogId} must exist in the catalog`
    );

    const entry = equipmentById.get(catalogId);
    assert.equal(flags.group, entry.group, `catalogId ${catalogId} must keep its group`);
    assert.equal(doc.name, entry.name, `catalogId ${catalogId} must keep its name`);
    assert.equal(doc._id, stableId(catalogId), `catalogId ${catalogId} must keep a stable id`);
    assert.equal(flags.catalogId, catalogId, 'catalogId must be preserved verbatim');

    assert.ok(!catalogIds.has(catalogId), `catalogId ${catalogId} must be unique`);
    catalogIds.add(catalogId);
    assert.ok(!generatedIds.has(doc._id), `item id ${doc._id} must be unique`);
    generatedIds.add(doc._id);

    byPack.set(pack, (byPack.get(pack) || 0) + 1);
  }

  const allCatalogIds = new Set(catalog.equipment.map((e) => e.id));
  assert.equal(catalogIds.size, allCatalogIds.size, 'no catalog entry may be dropped');
  for (const id of allCatalogIds) {
    assert.ok(catalogIds.has(id), `catalog entry ${id} must be present in a pack`);
  }

  for (const pack of PACKS) {
    assert.equal(byPack.get(pack.name), pack.expected, `${pack.name} must contain exactly ${pack.expected} items`);
  }
});

test('module.json declares three public dnd5e Item packs at the compiled paths', () => {
  const manifest = JSON.parse(readFileSync(MANIFEST_PATH, 'utf8'));
  assert.ok(Array.isArray(manifest.packs), 'module.json must declare a packs array');

  const declared = new Map(manifest.packs.map((p) => [p.name, p]));
  assert.equal(declared.size, PACKS.length, 'exactly three packs must be declared');

  for (const pack of PACKS) {
    const entry = declared.get(pack.name);
    assert.ok(entry, `pack ${pack.name} must be declared in module.json`);
    assert.equal(entry.type, 'Item', `${pack.name} must be an Item pack`);
    assert.equal(entry.system, 'dnd5e', `${pack.name} must target the dnd5e system`);
    assert.equal(entry.path, pack.path, `${pack.name} must point at its compiled path`);
    assert.ok(
      entry.private === undefined || entry.private === false,
      `${pack.name} must be a public pack`
    );
    assert.equal(typeof entry.label, 'string', `${pack.name} must have a label`);
    assert.ok(entry.label.length > 0, `${pack.name} label must be non-empty`);
  }

  for (const name of declared.keys()) {
    assert.ok(PACKS.some((p) => p.name === name), `unexpected pack ${name} declared`);
  }
});
