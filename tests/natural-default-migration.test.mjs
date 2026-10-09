import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  hasLegacyNaturalCandidate,
  hasLegacyNaturalDefault,
  legacyNaturalItemIds,
} from '../src/natural-default-migration.mjs';
import { computeActorTraining } from '../src/actor-training.mjs';
import { FLAGS_KEY } from '../src/items.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const catalog = JSON.parse(
  readFileSync(join(__dirname, '..', 'data', 'catalog.json'), 'utf8')
);
const equipment = catalog.equipment;

function naturalItem({
  id = 'natural-weapons/bite',
  activeTier = 'proficient',
  proficient = 1,
  flags = null,
} = {}) {
  return {
    id: id.replace('/', '-'),
    type: 'weapon',
    name: 'Bite',
    flags:
      flags === null
        ? { [FLAGS_KEY]: { catalogId: id, activeTier } }
        : flags,
    system: { proficient },
  };
}

function makeActor({ items = [], flags = {}, originalClass = null, isOwner = true } = {}) {
  const state = {};
  for (const [scope, values] of Object.entries(flags)) state[scope] = { ...values };
  return {
    id: 'a1',
    documentName: 'Actor',
    isOwner,
    items,
    system: { details: { originalClass } },
    getFlag(scope, key) {
      return state[scope]?.[key];
    },
    setFlag(scope, key, value) {
      (state[scope] ||= {})[key] = value;
    },
  };
}

// A natural-weapons Item as actually produced after a full sync, with the
// module-owned flag block and native proficient field.
function syncedNaturalItem({ id = 'natural-weapons/bite', proficiency = 0 } = {}) {
  return {
    id: id.replace('/', '-'),
    type: 'weapon',
    name: 'Bite',
    flags: {
      [FLAGS_KEY]: {
        catalogId: id,
        activeTier: proficiency ? 'proficient' : 'untrained',
      },
    },
    system: { proficient: proficiency },
  };
}

// ---------------------------------------------------------------------------
// hasLegacyNaturalCandidate
// ---------------------------------------------------------------------------

test('hasLegacyNaturalCandidate: true for a legacy proficient natural weapon', () => {
  const actor = makeActor({ items: [naturalItem()] });
  assert.equal(hasLegacyNaturalCandidate(actor), true);
});

test('hasLegacyNaturalCandidate: false when the active tier is not proficient', () => {
  const actor = makeActor({ items: [naturalItem({ activeTier: 'untrained' })] });
  assert.equal(hasLegacyNaturalCandidate(actor), false);
  const expert = makeActor({ items: [naturalItem({ activeTier: 'expert' })] });
  assert.equal(hasLegacyNaturalCandidate(expert), false);
});

test('hasLegacyNaturalCandidate: false when native proficiency was user-changed to 0', () => {
  const actor = makeActor({ items: [naturalItem({ proficient: 0 })] });
  assert.equal(hasLegacyNaturalCandidate(actor), false);
});

test('hasLegacyNaturalCandidate: false for a non-natural catalog id', () => {
  const actor = makeActor({
    items: [
      {
        id: 'battle-axe',
        type: 'weapon',
        name: 'Battle Axe',
        flags: { [FLAGS_KEY]: { catalogId: 'axes/battle-axe', activeTier: 'proficient' } },
        system: { proficient: 1 },
      },
    ],
  });
  assert.equal(hasLegacyNaturalCandidate(actor), false);
});

test('hasLegacyNaturalCandidate: false for an item without module flags or a null actor', () => {
  const noFlags = makeActor({ items: [{ type: 'weapon', system: { proficient: 1 } }] });
  assert.equal(hasLegacyNaturalCandidate(noFlags), false);
  assert.equal(hasLegacyNaturalCandidate(null), false);
});

// ---------------------------------------------------------------------------
// hasLegacyNaturalDefault
// ---------------------------------------------------------------------------

test('hasLegacyNaturalDefault: true for a legacy natural Item with no grant or override', () => {
  const actor = makeActor({ items: [naturalItem()] });
  assert.equal(hasLegacyNaturalDefault(actor, equipment), true);
});

test('hasLegacyNaturalDefault: false when a manual proficient override applies', () => {
  const actor = makeActor({
    items: [naturalItem()],
    flags: { [FLAGS_KEY]: { training: { items: { 'natural-weapons/bite': 'proficient' } } } },
  });
  assert.equal(hasLegacyNaturalDefault(actor, equipment), false);
});

test('hasLegacyNaturalDefault: false when a manual expert override applies', () => {
  const actor = makeActor({
    items: [naturalItem()],
    flags: { [FLAGS_KEY]: { training: { items: { 'natural-weapons/bite': 'expert' } } } },
  });
  assert.equal(hasLegacyNaturalDefault(actor, equipment), false);
});

test('hasLegacyNaturalDefault: false when a derived grant raises the natural weapon', () => {
  // A "Beast" subclass grants expert on bite/claw/tail; derive the training the
  // same way computeActorTraining does, then confirm the effective state is not
  // untrained and the function declines to migrate.
  const beast = {
    id: 'sub-beast',
    type: 'subclass',
    name: 'Path of the Beast',
    system: { advancement: [], classIdentifier: '' },
  };
  const actor = makeActor({ items: [naturalItem(), beast] });
  const effective = computeActorTraining(actor, equipment).effective;
  assert.equal(effective.items['natural-weapons/bite'], 'expert');
  assert.equal(hasLegacyNaturalDefault(actor, equipment), false);
});

test('hasLegacyNaturalDefault: false when native proficiency was user-changed to 0', () => {
  const actor = makeActor({ items: [naturalItem({ proficient: 0 })] });
  assert.equal(hasLegacyNaturalDefault(actor, equipment), false);
});

test('hasLegacyNaturalDefault: false when the active tier is not proficient', () => {
  const actor = makeActor({ items: [naturalItem({ activeTier: 'untrained' })] });
  assert.equal(hasLegacyNaturalDefault(actor, equipment), false);
});

test('hasLegacyNaturalDefault: false for a non-natural catalog id even at activeTier proficient', () => {
  const actor = makeActor({
    items: [naturalItem({ id: 'axes/battle-axe', activeTier: 'proficient' })],
  });
  assert.equal(hasLegacyNaturalDefault(actor, equipment), false);
});

test('hasLegacyNaturalDefault: false for an unknown natural-weapons id', () => {
  const actor = makeActor({ items: [naturalItem({ id: 'natural-weapons/unknown' })] });
  assert.equal(hasLegacyNaturalDefault(actor, equipment), false);
});

test('hasLegacyNaturalDefault: false for an untagged or null-actor input', () => {
  const noFlags = makeActor({ items: [{ type: 'weapon', system: { proficient: 1 } }] });
  assert.equal(hasLegacyNaturalDefault(noFlags, equipment), false);
  assert.equal(hasLegacyNaturalDefault(null, equipment), false);
  assert.equal(hasLegacyNaturalDefault(makeActor({ items: [] }), null), false);
});

test('hasLegacyNaturalDefault: already-untrained synced items are not candidates', () => {
  const actor = makeActor({ items: [syncedNaturalItem({ proficiency: 0 })] });
  assert.equal(hasLegacyNaturalDefault(actor, equipment), false);
});

test('hasLegacyNaturalDefault: does not mutate the actor or its items', () => {
  const item = naturalItem();
  const actor = makeActor({ items: [item] });
  const snapshot = structuredClone(item);
  const effectiveBefore = computeActorTraining(actor, equipment).effective.items['natural-weapons/bite'];
  assert.equal(effectiveBefore, 'untrained');
  hasLegacyNaturalDefault(actor, equipment);
  assert.deepEqual(actor.items[0], snapshot, 'the item object is unchanged');
  assert.equal(actor.items[0].system.proficient, 1);
  assert.equal(actor.items[0].flags[FLAGS_KEY].activeTier, 'proficient');
});

// ---------------------------------------------------------------------------
// legacyNaturalItemIds
// ---------------------------------------------------------------------------

test('legacyNaturalItemIds: returns the exact eligible item ids for a legacy natural weapon', () => {
  const actor = makeActor({ items: [naturalItem()] });
  assert.deepEqual([...legacyNaturalItemIds(actor, equipment)], ['natural-weapons-bite']);
});

test('legacyNaturalItemIds: matches the embedded _id when an item is serialized without an id', () => {
  const item = {
    _id: 'n-1',
    type: 'weapon',
    name: 'Bite',
    flags: { [FLAGS_KEY]: { catalogId: 'natural-weapons/bite', activeTier: 'proficient' } },
    system: { proficient: 1 },
  };
  const actor = makeActor({ items: [item] });
  assert.deepEqual([...legacyNaturalItemIds(actor, equipment)], ['n-1']);
});

test('legacyNaturalItemIds: empty when a manual proficient override applies', () => {
  const actor = makeActor({
    items: [naturalItem()],
    flags: { [FLAGS_KEY]: { training: { items: { 'natural-weapons/bite': 'proficient' } } } },
  });
  assert.equal(legacyNaturalItemIds(actor, equipment).size, 0);
});

test('legacyNaturalItemIds: empty when native proficiency was user-changed to 0', () => {
  const actor = makeActor({ items: [naturalItem({ proficient: 0 })] });
  assert.equal(legacyNaturalItemIds(actor, equipment).size, 0);
});

test('legacyNaturalItemIds: empty for a non-natural catalog id', () => {
  const actor = makeActor({
    items: [naturalItem({ id: 'axes/battle-axe', activeTier: 'proficient' })],
  });
  assert.equal(legacyNaturalItemIds(actor, equipment).size, 0);
});

test('legacyNaturalItemIds: only the qualifying duplicate is returned, not a user-edited 0 duplicate', () => {
  const actor = makeActor({
    items: [
      naturalItem({ id: 'natural-weapons/bite', activeTier: 'proficient', proficient: 1 }),
      naturalItem({ id: 'natural-weapons/bite', activeTier: 'proficient', proficient: 0 }),
    ],
  });
  // Both duplicates share a default item id (id.replace('/', '-')), so the stale one
  // is returned as the sole eligible id.
  assert.deepEqual([...legacyNaturalItemIds(actor, equipment)], ['natural-weapons-bite']);
});

test('legacyNaturalItemIds: honors a supplied picture and does not recompute when omitted', () => {
  const actor = makeActor({ items: [naturalItem()] });
  const picture = computeActorTraining(actor, equipment);
  const ids = legacyNaturalItemIds(actor, equipment, picture);
  assert.deepEqual([...ids], ['natural-weapons-bite']);
  // The same set is produced without an explicit picture (recomputed internally).
  assert.deepEqual([...legacyNaturalItemIds(actor, equipment)], ['natural-weapons-bite']);
});

test('legacyNaturalItemIds: returns an empty set for a null actor or null equipment and never mutates input', () => {
  assert.equal(legacyNaturalItemIds(null, equipment).size, 0);
  assert.equal(legacyNaturalItemIds(makeActor({ items: [] }), null).size, 0);
  const item = naturalItem();
  const actor = makeActor({ items: [item] });
  const snapshot = structuredClone(item);
  legacyNaturalItemIds(actor, equipment);
  assert.deepEqual(actor.items[0], snapshot, 'the item object is unchanged');
});

test('legacyNaturalItemIds: skips candidates that expose neither an id nor _id', () => {
  const bare = (name) => ({
    type: 'weapon',
    name,
    flags: { [FLAGS_KEY]: { catalogId: 'natural-weapons/bite', activeTier: 'proficient' } },
    system: { proficient: 1 },
  });
  const actor = makeActor({ items: [bare('Bite One'), bare('Bite Two')] });
  const ids = legacyNaturalItemIds(actor, equipment);
  assert.equal(ids.size, 0, 'a malformed no-id candidate must not be returned');
  assert.equal(ids.has(undefined), false, 'the set must not contain an undefined id');
});

test('legacyNaturalItemIds: keeps a valid candidate alongside malformed no-id items', () => {
  const actor = makeActor({
    items: [
      naturalItem({ id: 'natural-weapons/bite' }),
      { type: 'weapon', name: 'Claw', flags: { [FLAGS_KEY]: { catalogId: 'natural-weapons/claw', activeTier: 'proficient' } }, system: { proficient: 1 } },
    ],
  });
  const ids = legacyNaturalItemIds(actor, equipment);
  assert.deepEqual([...ids].sort(), ['natural-weapons-bite']);
});
