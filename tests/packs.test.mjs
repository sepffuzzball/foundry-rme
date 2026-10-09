import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

import { extractPack } from '@foundryvtt/foundryvtt-cli';
import { buildPacks } from '../scripts/build-packs.mjs';
import { ICON_MAP } from '../src/icon-map.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const MANIFEST_PATH = join(ROOT, 'module.json');

// The exact pack layout produced by build:packs.
const EQUIPMENT_PACKS = [
  { name: 'weapons', path: 'packs/weapons', expected: 153, kinds: ['weapon', 'natural'] },
  { name: 'armor', path: 'packs/armor', expected: 12, kinds: ['armor'] },
  { name: 'shields', path: 'packs/shields', expected: 8, kinds: ['shield'] },
];
const AMMO_PACK = { name: 'ammunition', path: 'packs/ammunition', expected: 25, kinds: [] };
const PACKS = [...EQUIPMENT_PACKS, AMMO_PACK];

const EQUIPMENT_EXPECTED = 173;
const AMMO_EXPECTED = 25;
const TOTAL_EXPECTED = EQUIPMENT_EXPECTED + AMMO_EXPECTED;

const catalog = JSON.parse(
  readFileSync(join(ROOT, 'data', 'catalog.json'), 'utf8')
);
const equipmentById = new Map(catalog.equipment.map((e) => [e.id, e]));
assert.equal(catalog.equipment.length, EQUIPMENT_EXPECTED, 'catalog must contain all 173 items');

const ammoSource = JSON.parse(
  readFileSync(join(ROOT, 'data', 'ammunition.json'), 'utf8')
).ammunition;
const ammoById = new Map(ammoSource.map((e) => [e.id, e]));
assert.equal(ammoSource.length, AMMO_EXPECTED, 'ammunition data must contain all 25 stacks');

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

// Ammunition ids are namespaced with `ammo/` so they never collide with the
// catalog-derived equipment ids.
function stableAmmoId(entryId) {
  return createHash('sha256').update(`ammo/${entryId}`, 'utf8').digest('hex').slice(0, 16);
}

// Build the packs exactly the way `npm run build:packs` does, then extract each
// pack back out of the compiled LevelDB pack and return every document.
async function buildAndExtract() {
  const summary = await buildPacks({ root: ROOT });
  assert.equal(summary.total, TOTAL_EXPECTED, `build must report all ${TOTAL_EXPECTED} items`);
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
    doc.type === 'weapon' || doc.type === 'equipment' || doc.type === 'consumable',
    `${packName} item type must be weapon, equipment, or a consumable`
  );

  assert.ok(doc.system && typeof doc.system === 'object', `${packName} item must have system`);
  // Curated description / unidentified / icon are module-owned on every item.
  const flags = doc.flags?.['foundry-rme'];
  const sourceId = flags?.catalogId || flags?.ammoId;
  assert.ok(sourceId, `${packName} item must carry a catalog/ammo id`);
  assert.ok(ICON_MAP[sourceId], `${packName} item source id ${sourceId} must have a curated icon`);
  assert.equal(doc.img, ICON_MAP[sourceId], `${packName} item must use the curated icon`);
  assert.equal(typeof doc.system.description?.value, 'string', `${packName} item must have a description value`);
  assert.ok(doc.system.description.value.length > 0, `${packName} description must be non-empty`);
  assert.equal(typeof doc.system.description?.chat, 'string', `${packName} item must have a chat snippet`);
  assert.ok(
    doc.system.unidentified && typeof doc.system.unidentified === 'object',
    `${packName} item must have an unidentified block`
  );
  assert.equal(typeof doc.system.unidentified?.name, 'string', `${packName} item must have an unidentified name`);
  assert.ok(doc.system.unidentified.name.length > 0, `${packName} unidentified name must be non-empty`);
  assert.equal(typeof doc.system.unidentified?.description, 'string', `${packName} item must have an unidentified description`);
  assert.ok(doc.system.unidentified.description.length > 0, `${packName} unidentified description must be non-empty`);

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

// Assert the full ammunition-item schema produced by the build for one source
// entry. `entry` is the corresponding data/ammunition.json record.
function assertValidAmmoSchema(doc, entry) {
  const flags = doc.flags['foundry-rme'];

  assert.equal(doc.type, 'consumable', 'ammunition items must be consumable');
  assert.equal(doc._id, stableAmmoId(entry.id), 'ammunition id must be derived from ammo/<id>');
  assert.equal(doc._key, `!items!${doc._id}`, 'ammunition _key must match its _id');

  assert.equal(doc.system.type?.value, 'ammo', 'ammunition system.type.value must be ammo');
  assert.equal(
    doc.system.type?.subtype,
    `rme-${entry.family}`,
    `ammunition system.type.subtype must be rme-${entry.family}`
  );
  assert.equal(doc.system.quantity, entry.quantity, 'ammunition quantity must match the source stack');
  assert.deepEqual(
    doc.system.weight,
    { value: 0, units: 'lb' },
    'ammunition weight must be an explicit zero pound weight'
  );
  assert.equal(
    doc.system.price.value,
    entry.stackCostGp / entry.quantity,
    'ammunition unit price must equal stack cost divided by quantity'
  );
  assert.equal(doc.system.price.denomination, 'gp', 'ammunition price must be in gp');

  // The curated icon and the identified / chat / unidentified description block.
  assert.equal(doc.img, ICON_MAP[entry.id], 'ammunition must use the curated icon');
  assert.equal(typeof doc.system.description?.value, 'string', 'ammunition must have a description value');
  assert.ok(doc.system.description.value.length > 0, 'ammunition description must be non-empty');
  assert.equal(typeof doc.system.description?.chat, 'string', 'ammunition must have a chat snippet');
  assert.equal(
    doc.system.unidentified?.name,
    'Unidentified Ammunition',
    'ammunition unidentified name must be generic'
  );
  assert.equal(typeof doc.system.unidentified?.description, 'string', 'ammunition must have an unidentified description');
  assert.ok(doc.system.unidentified.description.length > 0, 'ammunition unidentified description must be non-empty');

  assert.equal(flags.ammoId, entry.id, 'ammunition flags must preserve the ammo id');
  assert.equal(flags.family, entry.family, 'ammunition flags must preserve the family');
  assert.equal(flags.stackCostGp, entry.stackCostGp, 'ammunition flags must preserve the stack cost');
  assert.ok(flags.effect && typeof flags.effect === 'object', 'ammunition flags must carry an effect object');
  assert.equal(
    typeof flags.effect.text,
    'string',
    'ammunition effect must include declarative text'
  );
  assert.ok(flags.effect.text.length > 0, 'ammunition effect text must be non-empty');
}

test('build:packs produces exactly four compendium packs with the expected counts', async () => {
  const built = await buildPacks({ root: ROOT });
  assert.equal(built.total, TOTAL_EXPECTED, 'all catalog entries must be packed');

  const byName = new Map(built.groups.map((g) => [g.name, g.count]));
  assert.equal(byName.size, PACKS.length, 'exactly four packs must be compiled');

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

test('all 198 items survive a compile/extract round-trip with valid IDs and schema', async () => {
  const extracted = await buildAndExtract();
  assert.equal(extracted.length, TOTAL_EXPECTED, `must extract all ${TOTAL_EXPECTED} items`);

  const byPack = new Map();
  for (const { pack, doc } of extracted) {
    assertValidItemSchema(doc, pack);
    if (pack === AMMO_PACK.name) {
      const flags = doc.flags['foundry-rme'];
      const entry = ammoById.get(flags.ammoId);
      assert.ok(entry, `ammunition id ${flags.ammoId} must exist in data/ammunition.json`);
      assertValidAmmoSchema(doc, entry);
    }
    byPack.set(pack, (byPack.get(pack) || 0) + 1);
  }

  for (const pack of PACKS) {
    assert.equal(byPack.get(pack.name), pack.expected, `${pack.name} must extract exactly ${pack.expected} items`);
  }
});

test('every extracted equipment item preserves its original catalogId with unique, stable ids', async () => {
  const extracted = (await buildAndExtract()).filter(({ pack }) => pack !== AMMO_PACK.name);

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

  for (const pack of EQUIPMENT_PACKS) {
    assert.equal(byPack.get(pack.name), pack.expected, `${pack.name} must contain exactly ${pack.expected} items`);
  }
});

test('all 25 ammunition items round-trip with unique stable ids, per-unit prices, and stack quantities', async () => {
  const extracted = (await buildAndExtract()).filter(({ pack }) => pack === AMMO_PACK.name);
  assert.equal(extracted.length, AMMO_EXPECTED, `must extract all ${AMMO_EXPECTED} ammunition stacks`);

  const ammoIds = new Set();
  const generatedIds = new Set();

  for (const { doc } of extracted) {
    const entry = ammoById.get(doc.flags['foundry-rme'].ammoId);
    assert.ok(entry, `ammunition id ${doc.flags['foundry-rme'].ammoId} must exist in data/ammunition.json`);
    assertValidAmmoSchema(doc, entry);

    assert.ok(!ammoIds.has(entry.id), `ammunition id ${entry.id} must be unique`);
    ammoIds.add(entry.id);
    assert.ok(!generatedIds.has(doc._id), `item id ${doc._id} must be unique`);
    generatedIds.add(doc._id);
  }

  // Every data/ammunition.json stack must be present exactly once.
  assert.equal(ammoIds.size, ammoSource.length, 'no ammunition stack may be dropped');
  for (const entry of ammoSource) {
    assert.ok(ammoIds.has(entry.id), `ammunition stack ${entry.id} must be present in a pack`);
  }
});

test('module.json declares four public dnd5e Item packs at the compiled paths', () => {
  const manifest = JSON.parse(readFileSync(MANIFEST_PATH, 'utf8'));
  assert.ok(Array.isArray(manifest.packs), 'module.json must declare a packs array');

  const declared = new Map(manifest.packs.map((p) => [p.name, p]));
  assert.equal(declared.size, PACKS.length, 'exactly four packs must be declared');

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

// The exact user-approved homebrew defaults for every ammunition stack's
// description and declarative effect. These are the values the module ships as
// its own defaults, not RME source rule text, so every description also carries
// the homebrew-default provenance label.
const EXPECTED_AMMO_DEFAULTS = {
  "crossbow/bolts": {
    description: "A standard crossbow bolt. Crossbow bolts are small and usually metal, making them much harder on a critical hit. A crossbow can be stored loaded and primed to shoot, unlike a bow or launch weapon. Module homebrew default - not RME source rule text.",
    effect: { text: "A standard crossbow bolt. Deals piercing damage.", damageType: "piercing" },
  },
  "crossbow/walloping-bolts": {
    description: "A crossbow bolt crafted to knock a target off its feet. On a hit the target must succeed on a Strength saving throw (DC 10) or be knocked prone. Module homebrew default - not RME source rule text.",
    effect: {
      text: "On a hit, the target must succeed on a Strength saving throw (DC 10) or be knocked prone.",
      tags: ["knockback"],
      trigger: "on-hit",
      save: { ability: "str", dc: 10 },
      condition: "prone",
    },
  },
  "crossbow/goading-bolts": {
    description: "A crossbow bolt that draws a creature's ire. On a hit the target must succeed on a Wisdom saving throw (DC 13) or have disadvantage on attacks against creatures other than the shooter until the end of the target's next turn. Module homebrew default - not RME source rule text.",
    effect: {
      text: "On a hit, the target must succeed on a Wisdom saving throw (DC 13) or have disadvantage on attacks against creatures other than the shooter until the end of the target's next turn.",
      tags: ["taunt"],
      trigger: "on-hit",
      save: { ability: "wis", dc: 13 },
      condition: "goaded",
      duration: "until end of target's next turn",
    },
  },
  "crossbow/plus-1-bolts": {
    description: "A finely balanced bolt that grants a +1 bonus to attack and damage rolls. Module homebrew default - not RME source rule text.",
    effect: { text: "Grants a +1 bonus to attack and damage rolls.", tags: ["bonus"], attackBonus: 1, damageBonus: 1 },
  },
  "spinner/bladed-disks": {
    description: "A spinning disk of steel loaded into a Spinner. The Spinner's internal mechanisms launch disk blades instead of prods, and it holds ten blades at a time. Module homebrew default - not RME source rule text.",
    effect: { text: "A spinning disk blade. Deals slashing damage.", damageType: "slashing" },
  },
  "arrow/arrows": {
    description: "A standard arrow. Bows require more training than crossbows, but reload faster, keeping them relevant in the age of mechanical winding and gunpowder. Module homebrew default - not RME source rule text.",
    effect: { text: "A standard arrow. Deals piercing damage.", damageType: "piercing" },
  },
  "arrow/fire-arrows": {
    description: "An arrow tipped with a combustible charge that deals an extra 1d4 fire damage on a hit. Module homebrew default - not RME source rule text.",
    effect: { text: "On a hit, deals an extra 1d4 fire damage.", trigger: "on-hit", extraDamage: { formula: "1d4", type: "fire" } },
  },
  "arrow/ice-arrows": {
    description: "An arrow of ice that deals an extra 1d4 cold damage on a hit. Module homebrew default - not RME source rule text.",
    effect: { text: "On a hit, deals an extra 1d4 cold damage.", trigger: "on-hit", extraDamage: { formula: "1d4", type: "cold" } },
  },
  "arrow/poison-arrows": {
    description: "A venom-tipped arrow that deals an extra 1d4 poison damage on a hit. Module homebrew default - not RME source rule text.",
    effect: { text: "On a hit, deals an extra 1d4 poison damage.", trigger: "on-hit", extraDamage: { formula: "1d4", type: "poison" } },
  },
  "arrow/shock-arrows": {
    description: "An arrow that discharges an extra 1d4 lightning damage on a hit. Module homebrew default - not RME source rule text.",
    effect: { text: "On a hit, deals an extra 1d4 lightning damage.", trigger: "on-hit", extraDamage: { formula: "1d4", type: "lightning" } },
  },
  "arrow/acid-arrows": {
    description: "A corrosive arrow that deals an extra 1d4 acid damage on a hit. Module homebrew default - not RME source rule text.",
    effect: { text: "On a hit, deals an extra 1d4 acid damage.", trigger: "on-hit", extraDamage: { formula: "1d4", type: "acid" } },
  },
  "arrow/thunder-arrows": {
    description: "An arrow that bursts with thunder, dealing an extra 1d4 thunder damage on a hit. Module homebrew default - not RME source rule text.",
    effect: { text: "On a hit, deals an extra 1d4 thunder damage.", trigger: "on-hit", extraDamage: { formula: "1d4", type: "thunder" } },
  },
  "arrow/plus-1-arrows": {
    description: "A finely balanced arrow that grants a +1 bonus to attack and damage rolls. Module homebrew default - not RME source rule text.",
    effect: { text: "Grants a +1 bonus to attack and damage rolls.", tags: ["bonus"], attackBonus: 1, damageBonus: 1 },
  },
  "rifle/rifle-cartridge": {
    description: "A rifle cartridge filled with primer, powder, and a projectile, launched when struck by a hammer or striker. Deals piercing damage. Module homebrew default - not RME source rule text.",
    effect: { text: "A standard rifle cartridge. Deals piercing damage.", damageType: "piercing" },
  },
  "rifle/match-grade-rifle-cartridge": {
    description: "A meticulously balanced rifle cartridge that grants a +1 bonus to attack and damage rolls. Module homebrew default - not RME source rule text.",
    effect: { text: "Grants a +1 bonus to attack and damage rolls.", tags: ["bonus"], attackBonus: 1, damageBonus: 1 },
  },
  "rifle/masterwork-rifle-cartridge": {
    description: "A master-crafted rifle cartridge that grants a +2 bonus to attack and damage rolls. Module homebrew default - not RME source rule text.",
    effect: { text: "Grants a +2 bonus to attack and damage rolls.", tags: ["bonus"], attackBonus: 2, damageBonus: 2 },
  },
  "shotgun/slugs": {
    description: "A single heavy projectile for a shotgun. Deals piercing damage and carries its stopping power further than shot. Module homebrew default - not RME source rule text.",
    effect: { text: "A single heavy projectile. Deals piercing damage.", damageType: "piercing" },
  },
  "shotgun/buckshot": {
    description: "A payload of small bearing-sized balls for a shotgun that fires in a 15-foot cone and uses one fewer base damage die. Module homebrew default - not RME source rule text.",
    effect: {
      text: "Fires in a 15-foot cone. Uses one fewer base damage die.",
      tags: ["spread", "cone"],
      damageType: "piercing",
      radiusFeet: 15,
    },
  },
  "pistol/pistol-cartridge": {
    description: "A pistol cartridge filled with primer, powder, and a projectile. Deals piercing damage. Module homebrew default - not RME source rule text.",
    effect: { text: "A standard pistol cartridge. Deals piercing damage.", damageType: "piercing" },
  },
  "pistol/match-grade-pistol-cartridge": {
    description: "A finely balanced pistol cartridge that grants a +1 bonus to attack and damage rolls. Module homebrew default - not RME source rule text.",
    effect: { text: "Grants a +1 bonus to attack and damage rolls.", tags: ["bonus"], attackBonus: 1, damageBonus: 1 },
  },
  "pistol/masterwork-pistol-cartridge": {
    description: "A master-crafted pistol cartridge that grants a +2 bonus to attack and damage rolls. Module homebrew default - not RME source rule text.",
    effect: { text: "Grants a +2 bonus to attack and damage rolls.", tags: ["bonus"], attackBonus: 2, damageBonus: 2 },
  },
  "mpl/mpl-grenade": {
    description: "A Multi-Purpose Launcher round that bursts on impact in a 10-foot radius, forcing a Dexterity saving throw (DC 13) for 2d6 bludgeoning damage (half on a success). Module homebrew default - not RME source rule text.",
    effect: {
      text: "Bursts on impact in a 10-foot radius. Targets in the radius must succeed on a Dexterity saving throw (DC 13) or take 2d6 bludgeoning damage, half on a success.",
      tags: ["area", "explosive"],
      payload: "grenade",
      trigger: "on-hit",
      radiusFeet: 10,
      save: { ability: "dex", dc: 13 },
      damage: { formula: "2d6", type: "bludgeoning" },
      halfOnSave: true,
    },
  },
  "mpl/mpl-smoke": {
    description: "A Multi-Purpose Launcher round that produces a cloud of smoke in a 20-foot radius, heavily obscuring the area for 1 minute. Module homebrew default - not RME source rule text.",
    effect: {
      text: "Produces a cloud of smoke in a 20-foot radius that heavily obscures the area for 1 minute.",
      tags: ["area", "obscuring"],
      payload: "smoke",
      radiusFeet: 20,
      condition: "heavily-obscured",
      duration: "1 minute",
    },
  },
  "mpl/mpl-flashbang": {
    description: "A Multi-Purpose Launcher round that blinds creatures in a 10-foot radius with a brilliant flash. Targets must succeed on a Constitution saving throw (DC 13) or be blinded until the end of their next turn. Module homebrew default - not RME source rule text.",
    effect: {
      text: "Bursts in a 10-foot radius with a brilliant flash. Targets must succeed on a Constitution saving throw (DC 13) or be blinded until the end of their next turn.",
      tags: ["area", "blind"],
      payload: "flashbang",
      radiusFeet: 10,
      save: { ability: "con", dc: 13 },
      condition: "blinded",
      duration: "until end of target's next turn",
    },
  },
  "mpl/mpl-incendiary": {
    description: "A Multi-Purpose Launcher round that bursts in a 10-foot radius, forcing a Dexterity saving throw (DC 13) for 2d6 fire damage (half on a success). Module homebrew default - not RME source rule text.",
    effect: {
      text: "Bursts in a 10-foot radius. Targets in the radius must succeed on a Dexterity saving throw (DC 13) or take 2d6 fire damage, half on a success.",
      tags: ["area", "fire"],
      payload: "incendiary",
      trigger: "on-hit",
      radiusFeet: 10,
      save: { ability: "dex", dc: 13 },
      damage: { formula: "2d6", type: "fire" },
      halfOnSave: true,
    },
  },
};

test('data/ammunition.json carries exact user-approved homebrew defaults for every stack', () => {
  const pinned = Object.keys(EXPECTED_AMMO_DEFAULTS);
  assert.equal(pinned.length, AMMO_EXPECTED, 'defaults must be pinned for all 25 stacks');
  assert.equal(ammoSource.length, pinned.length, 'every stack must have a pinned default');

  for (const entry of ammoSource) {
    const expected = EXPECTED_AMMO_DEFAULTS[entry.id];
    assert.ok(expected, `no approved default pinned for ${entry.id}`);
    assert.equal(
      entry.description,
      expected.description,
      `${entry.id} description must match the approved homebrew default`
    );
    assert.deepEqual(entry.effect, expected.effect, `${entry.id} effect must match the approved default`);
    assert.match(
      entry.description,
      /Module homebrew default - not RME source rule text\.$/,
      `${entry.id} description must be labeled as a module homebrew default`
    );
  }

  // Every pinned default must correspond to a real, present stack.
  const seen = new Set(ammoSource.map((e) => e.id));
  for (const id of pinned) {
    assert.ok(seen.has(id), `pinned default ${id} must correspond to a real stack`);
  }
});
