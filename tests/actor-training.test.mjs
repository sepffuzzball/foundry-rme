import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  resolveEffectiveTraining,
  effectiveItemLevels,
  computeActorTraining,
  syncActorRme,
} from '../src/actor-training.mjs';
import { FLAGS_KEY } from '../src/items.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const catalog = JSON.parse(
  readFileSync(join(__dirname, '..', 'data', 'catalog.json'), 'utf8')
);
const equipment = catalog.equipment;

function entry(id) {
  const e = equipment.find((x) => x.id === id);
  assert.ok(e, `missing catalog entry ${id}`);
  return e;
}

const battleAxe = entry('axes/battle-axe');
const shortbow = entry('bows/shortbow');
const naturalBite = entry('natural-weapons/bite');
const unarmedStrike = entry('natural-weapons/unarmed-strike');
const plate = entry('armor/plate');

const EIGHT = [
  'Axes',
  'Bows',
  'Combat Blades',
  'Dueling Blades',
  'Flails',
  'Hammers Picks',
  'Spears',
  'Whips',
];

// --- mock item / actor builders -------------------------------------------

function classItem(id, name, classIdentifier) {
  return { id, type: 'class', name, system: { classIdentifier, advancement: [] } };
}

function raceItem(id, name, advancement) {
  return { id, type: 'race', name, system: { identifier: name.toLowerCase(), advancement } };
}

function traitAdvancement({ grants = [], chosen = [], choices = null, type = 'Traits' } = {}) {
  const configuration = { grants };
  if (choices) configuration.choices = choices;
  return { _id: 't1', type, configuration, value: { chosen } };
}

function deepClone(value) {
  return JSON.parse(JSON.stringify(value));
}

function mergeItem(item, update) {
  const merged = { ...item, system: { ...item.system } };
  for (const [key, value] of Object.entries(update.system)) {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      merged.system[key] = { ...(merged.system[key] || {}), ...value };
    } else {
      merged.system[key] = value;
    }
  }
  if (update.flags) {
    merged.flags = { ...(merged.flags || {}) };
    merged.flags[FLAGS_KEY] = {
      ...(merged.flags?.[FLAGS_KEY] || {}),
      ...update.flags[FLAGS_KEY],
    };
  }
  if (update.img !== undefined) {
    merged.img = update.img;
  }
  return merged;
}

// A Foundry-shaped mock: flags are nested by scope, and sync writes are applied
// to `items` so idempotency can be observed.
function makeActor({ items = [], flags = {}, originalClass = null } = {}) {
  const state = {};
  for (const [scope, values] of Object.entries(flags)) state[scope] = { ...values };
  let lastUpdates = null;
  const actor = {
    items,
    system: { details: { originalClass } },
    getFlag(scope, key) {
      return state[scope]?.[key];
    },
    setFlag(scope, key, value) {
      (state[scope] ||= {})[key] = value;
    },
    unsetFlag(scope, key) {
      if (state[scope]) delete state[scope][key];
    },
    async updateEmbeddedDocuments(type, updates) {
      assert.equal(type, 'Item');
      lastUpdates = updates;
      for (const update of updates) {
        const idx = items.findIndex((i) => i._id === update._id);
        if (idx !== -1) items[idx] = mergeItem(items[idx], update);
      }
      return updates;
    },
  };
  actor.__lastUpdates = () => lastUpdates;
  actor.__state = state;
  return actor;
}

// ---------------------------------------------------------------------------
// resolveEffectiveTraining - precedence
// ---------------------------------------------------------------------------

test('resolveEffectiveTraining: an explicit manual untrained item overrides a derived expert', () => {
  const derived = { groups: { Axes: 'expert' }, items: {} };
  const manual = { items: { 'axes/battle-axe': 'untrained' } };
  assert.equal(resolveEffectiveTraining(battleAxe, manual, derived), 'untrained');
});

test('resolveEffectiveTraining: explicit untrained beats a manual group expert', () => {
  const manual = {
    items: { 'axes/battle-axe': 'untrained' },
    groups: { Axes: 'expert' },
  };
  assert.equal(resolveEffectiveTraining(battleAxe, manual, {}), 'untrained');
});

test('resolveEffectiveTraining: a manual expert group overrides a derived individual proficient', () => {
  const manual = { groups: { Bows: 'expert' } };
  const derived = { items: { 'bows/shortbow': 'proficient' }, groups: {} };
  // manual.groups outranks derived.items, so the group expert wins.
  assert.equal(resolveEffectiveTraining(shortbow, manual, derived), 'expert');
});

test('resolveEffectiveTraining: a manual item expert overrides a manual group untrained', () => {
  const manual = {
    items: { 'axes/battle-axe': 'expert' },
    groups: { Axes: 'untrained' },
  };
  assert.equal(resolveEffectiveTraining(battleAxe, manual, {}), 'expert');
});

test('resolveEffectiveTraining: derived item level beats derived group level', () => {
  const derived = { items: { 'axes/battle-axe': 'proficient' }, groups: { Axes: 'expert' } };
  assert.equal(resolveEffectiveTraining(battleAxe, {}, derived), 'proficient');
});

test('resolveEffectiveTraining: falls through to untrained when nothing owns the entry', () => {
  // Natural weapons no longer carry a default level; like any other entry they
  // fall through to untrained.
  assert.equal(resolveEffectiveTraining(naturalBite, {}, {}), 'untrained');
  assert.equal(resolveEffectiveTraining(unarmedStrike, {}, {}), 'untrained');
});

test('computeActorTraining: natural weapons compute untrained without grants', () => {
  const actor = makeActor({ items: [] });
  const result = computeActorTraining(actor, equipment);
  assert.equal(result.effective.items['natural-weapons/claw'], 'untrained');
  assert.equal(result.effective.items['natural-weapons/bite'], 'untrained');
  assert.equal(result.effective.items['natural-weapons/tail'], 'untrained');
  assert.equal(result.effective.items['natural-weapons/unarmed-strike'], 'untrained');
});

// ---------------------------------------------------------------------------
// effectiveItemLevels
// ---------------------------------------------------------------------------

test('effectiveItemLevels: returns a level for every equipment entry', () => {
  const result = effectiveItemLevels(equipment, { groups: { Axes: 'expert' } }, {});
  assert.equal(Object.keys(result.items).length, equipment.length);
  assert.equal(result.items['axes/battle-axe'], 'expert');
  assert.ok('natural-weapons/unarmed-strike' in result.items);
});

// ---------------------------------------------------------------------------
// computeActorTraining - derived composition and provider removal
// ---------------------------------------------------------------------------

test('computeActorTraining: class plus species grants combine to an expert item', () => {
  const fighterId = 'cls-fighter';
  const fItem = classItem(fighterId, 'Fighter', 'fighter');
  const dItem = raceItem('race-dwarf', 'Dwarf', [traitAdvancement({ grants: ['weapon:battle-axe'] })]);
  const actor = makeActor({
    items: [fItem, dItem],
    flags: { 'foundry-rme': { choices: { [fighterId]: { groups: EIGHT } } } },
    originalClass: fighterId,
  });

  const result = computeActorTraining(actor, equipment);
  assert.deepEqual(result.manual, {});
  assert.equal(result.derived.items['axes/battle-axe'], 'expert');
  assert.equal(result.effective.items['axes/battle-axe'], 'expert');
  // The expert level is traced to both a class and a species (race) provider.
  assert.deepEqual(result.sources.map((s) => s.type), ['class', 'race']);
});

test('computeActorTraining: removing the race provider recalculates a lower tier', () => {
  const fighterId = 'cls-fighter';
  const fItem = classItem(fighterId, 'Fighter', 'fighter');
  const dItem = raceItem('race-dwarf', 'Dwarf', [traitAdvancement({ grants: ['weapon:battle-axe'] })]);
  const flags = { 'foundry-rme': { choices: { [fighterId]: { groups: EIGHT } } } };

  const withDwarf = makeActor({ items: [fItem, dItem], flags, originalClass: fighterId });
  const r1 = computeActorTraining(withDwarf, equipment);
  assert.equal(r1.effective.items['axes/battle-axe'], 'expert');

  // The same fighter without the dwarf race no longer supplies a second source,
  // so the battleaxe recomputes down to the group proficient tier.
  const withoutDwarf = makeActor({ items: [fItem], flags, originalClass: fighterId });
  const r2 = computeActorTraining(withoutDwarf, equipment);
  assert.equal(r2.effective.items['axes/battle-axe'], 'proficient');
  assert.ok(!('axes/battle-axe' in r2.derived.items));
  assert.equal(r2.derived.groups['Axes'], 'proficient');
});

// ---------------------------------------------------------------------------
// computeActorTraining - gaps and no-mutation guarantees
// ---------------------------------------------------------------------------

test('computeActorTraining: a fighter with missing category choices reports a gap', () => {
  const fighterId = 'cls-fighter';
  const fItem = classItem(fighterId, 'Fighter', 'fighter');
  const actor = makeActor({ items: [fItem], originalClass: fighterId });

  const result = computeActorTraining(actor, equipment);
  assert.deepEqual(result.manual, {});
  const gap = result.gaps.find((g) => g.sourceId === fighterId && g.type === 'groups');
  assert.ok(gap, 'expected a groups gap for the fighter');
  assert.equal(gap.count, 8);
  // The fixed armor grants are still derived without guessing the groups.
  assert.equal(result.derived.items['armor/plate'], 'proficient');
  assert.equal(result.effective.items['armor/plate'], 'proficient');
  // The non-choice item falls through to untrained.
  assert.equal(result.effective.items['axes/battle-axe'], 'untrained');
});

test('computeActorTraining: does not mutate the actor or native trait proficiencies', () => {
  const fighterId = 'cls-fighter';
  const fItem = classItem(fighterId, 'Fighter', 'fighter');
  const actor = makeActor({
    items: [fItem],
    flags: { 'foundry-rme': { training: { groups: { Axes: 'expert' } } } },
    originalClass: fighterId,
  });
  actor.system.traits = { weapons: ['mar'], armor: 'lgt' };
  const before = deepClone(actor);

  computeActorTraining(actor, equipment);

  assert.deepEqual(actor.system.traits, before.system.traits);
  assert.equal(actor.system.details.originalClass, fighterId);
  assert.equal(actor.items.length, 1);
  assert.equal(actor.__lastUpdates(), null);
});

// ---------------------------------------------------------------------------
// syncActorRme
// ---------------------------------------------------------------------------

test('syncActorRme: applies the effective state to actor items and is idempotent', async () => {
  const items = [
    {
      _id: 'i1',
      flags: { [FLAGS_KEY]: { catalogId: 'axes/battle-axe' } },
      system: { proficient: 0 },
    },
  ];
  const actor = makeActor({
    items,
    flags: { 'foundry-rme': { training: { groups: { Axes: 'proficient' } } } },
  });

  const first = await syncActorRme(actor, equipment);
  assert.equal(first.effective.items['axes/battle-axe'], 'proficient');
  assert.equal(first.updates.length, 1);
  assert.equal(first.updates[0]._id, 'i1');
  assert.equal(items[0].system.proficient, 1);

  // A second sync after the state has been applied writes nothing.
  const second = await syncActorRme(actor, equipment);
  assert.deepEqual(second.updates, []);
  assert.equal(second.effective.items['axes/battle-axe'], 'proficient');
});

test('syncActorRme: preserves a user-edited versatile die across a coincidental expert upgrade', async () => {
  const items = [
    {
      _id: 'ba-edit-1',
      flags: { [FLAGS_KEY]: { catalogId: battleAxe.id } },
      system: { proficient: 0 },
    },
  ];
  const actor = makeActor({
    items,
    flags: { 'foundry-rme': { training: { groups: { Axes: 'proficient' } } } },
  });

  const first = await syncActorRme(actor, equipment);
  assert.equal(first.updates.length, 1);
  assert.equal(items[0].flags[FLAGS_KEY].nativeVersatileDamage, true);
  assert.deepEqual(items[0].system.damage.versatile, {
    number: 1,
    denomination: 10,
    bonus: '',
    types: ['slashing'],
  });

  // The user changes the two-handed die before an expert upgrade; the expert
  // tier's native die is also d12, but the user value must never be overwritten.
  items[0].system.damage.versatile = { number: 1, denomination: 12, bonus: '', types: ['slashing'] };

  // Advance the group training to expert for this axe.
  actor.__state['foundry-rme'].training = { groups: { Axes: 'expert' } };
  const second = await syncActorRme(actor, equipment);
  assert.ok(second.updates.length >= 1);
  assert.deepEqual(items[0].system.damage.versatile, {
    number: 1,
    denomination: 12,
    bonus: '',
    types: ['slashing'],
  });
  assert.equal(items[0].flags[FLAGS_KEY].nativeVersatileDamage, false);
  assert.equal(items[0].flags[FLAGS_KEY].nativeVersatileSnapshot, null);

  // A further sync at the same expert tier writes nothing.
  const third = await syncActorRme(actor, equipment);
  assert.deepEqual(third.updates, []);
});

test('syncActorRme: leaves items without a known catalogId untouched', async () => {
  const items = [
    { _id: 'u1', flags: {}, system: { proficient: 0 } },
    {
      _id: 'u2',
      flags: { [FLAGS_KEY]: { catalogId: 'not-in-catalog' } },
      system: { proficient: 1 },
    },
    {
      _id: 'k1',
      flags: { [FLAGS_KEY]: { catalogId: 'axes/battle-axe' } },
      system: { proficient: 0 },
    },
  ];
  const actor = makeActor({
    items,
    flags: { 'foundry-rme': { training: { groups: { Axes: 'proficient' } } } },
  });

  const result = await syncActorRme(actor, equipment);
  assert.equal(result.updates.length, 1);
  assert.equal(result.updates[0]._id, 'k1');
  assert.equal(items[0].system.proficient, 0);
  assert.equal(items[1].system.proficient, 1);
});
