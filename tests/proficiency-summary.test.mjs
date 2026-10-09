import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { summarizeRmeProficiencies } from '../src/proficiency-summary.mjs';
import { computeActorTraining } from '../src/actor-training.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const catalog = JSON.parse(
  readFileSync(join(__dirname, '..', 'data', 'catalog.json'), 'utf8')
);
const equipment = catalog.equipment;

function byGroup(group) {
  return equipment.filter((e) => e.group === group);
}

function byKind(kind) {
  return equipment.filter((e) => e.kind === kind);
}

function entry(id) {
  const e = equipment.find((x) => x.id === id);
  assert.ok(e, `missing catalog entry ${id}`);
  return e;
}

function deepClone(value) {
  return JSON.parse(JSON.stringify(value));
}

// Build a computeActorTraining-shaped picture. `items` maps entry ids to levels.
function picture(manual, derived, items) {
  return {
    manual,
    derived,
    gaps: [],
    sources: [],
    effective: { items },
  };
}

// ---------------------------------------------------------------------------
// Firearms group
// ---------------------------------------------------------------------------

test('firearms: group proficient with one expert rifle -> category plus expert item row', () => {
  const firearms = byGroup('Firearms');
  const effective = {};
  for (const e of firearms) effective[e.id] = 'proficient';
  effective['firearms/bolt-action-rifle'] = 'expert';

  const result = summarizeRmeProficiencies(
    firearms,
    picture({ groups: { Firearms: 'proficient' } }, {}, effective)
  );

  assert.deepEqual(result.armor, []);
  assert.deepEqual(result.weapons, [
    { kind: 'category', label: 'Firearms', level: 'proficient', exceptions: [{ label: 'Bolt-Action Rifle', level: 'expert' }] },
    { kind: 'item', label: 'Bolt-Action Rifle', level: 'expert' },
  ]);
});

test('firearms: expert group with explicitly untrained rifle -> expert category, untrained only as exception', () => {
  const firearms = byGroup('Firearms');
  const effective = {};
  for (const e of firearms) effective[e.id] = 'expert';
  effective['firearms/bolt-action-rifle'] = 'untrained';

  const result = summarizeRmeProficiencies(
    firearms,
    picture({ groups: { Firearms: 'expert' } }, {}, effective)
  );

  assert.deepEqual(result.weapons, [
    { kind: 'category', label: 'Firearms', level: 'expert', exceptions: [{ label: 'Bolt-Action Rifle', level: 'untrained' }] },
  ]);
});

test('firearms: manual group untrained suppresses derived expert -> no category', () => {
  const firearms = byGroup('Firearms');
  const effective = {};
  for (const e of firearms) effective[e.id] = 'untrained';

  const result = summarizeRmeProficiencies(
    firearms,
    picture(
      { groups: { Firearms: 'untrained' } },
      { groups: { Firearms: 'expert' } },
      effective
    )
  );

  assert.deepEqual(result.weapons, []);
});

test('firearms: manual group untrained with an independent positive item -> individual row only', () => {
  const firearms = byGroup('Firearms');
  const effective = {};
  for (const e of firearms) effective[e.id] = 'untrained';
  effective['firearms/bolt-action-rifle'] = 'proficient';

  const result = summarizeRmeProficiencies(
    firearms,
    picture(
      { groups: { Firearms: 'untrained' } },
      { groups: { Firearms: 'expert' } },
      effective
    )
  );

  assert.deepEqual(result.weapons, [
    { kind: 'item', label: 'Bolt-Action Rifle', level: 'proficient' },
  ]);
});

// ---------------------------------------------------------------------------
// Armor / shields
// ---------------------------------------------------------------------------

test('armor: light/medium/heavy and shield categories are emitted', () => {
  const armorKit = [...byKind('armor'), ...byKind('shield')];
  const effective = {};
  for (const e of armorKit) effective[e.id] = 'proficient';

  const result = summarizeRmeProficiencies(armorKit, picture({}, {}, effective));

  assert.deepEqual(result.weapons, []);
  assert.deepEqual(result.armor, [
    { kind: 'category', label: 'Heavy Armor', level: 'proficient', exceptions: [] },
    { kind: 'category', label: 'Light Armor', level: 'proficient', exceptions: [] },
    { kind: 'category', label: 'Medium Armor', level: 'proficient', exceptions: [] },
    { kind: 'category', label: 'Shields', level: 'proficient', exceptions: [] },
  ]);
});

test('armor: mixed proficient/expert with no group grant emits individual rows, not a category', () => {
  const light = byGroup('Armor').filter((e) =>
    ['Padded', 'Leather', 'Studded', 'Lacquered'].includes(e.name)
  );
  assert.equal(light.length, 4);
  const effective = {};
  for (const e of light) effective[e.id] = 'proficient';
  effective['armor/studded'] = 'expert';

  const result = summarizeRmeProficiencies(light, picture({}, {}, effective));

  assert.deepEqual(result.armor, [
    { kind: 'item', label: 'Lacquered', level: 'proficient' },
    { kind: 'item', label: 'Leather', level: 'proficient' },
    { kind: 'item', label: 'Padded', level: 'proficient' },
    { kind: 'item', label: 'Studded', level: 'expert' },
  ]);
});

test('armor: an unmapped armor entry is reported individually', () => {
  const custom = { id: 'armor/custom', name: 'Custom Plate', kind: 'armor', group: 'Armor', tiers: [] };
  const effective = { 'armor/custom': 'proficient' };

  const result = summarizeRmeProficiencies([custom], picture({}, {}, effective));

  assert.deepEqual(result.armor, [
    { kind: 'item', label: 'Custom Plate', level: 'proficient' },
  ]);
  assert.deepEqual(result.weapons, []);
});

// ---------------------------------------------------------------------------
// No category when only a majority is individually trained
// ---------------------------------------------------------------------------

test('armor: three of four Light Armor members proficient with no group grant -> three individual rows', () => {
  const light = byGroup('Armor').filter((e) =>
    ['Padded', 'Leather', 'Studded', 'Lacquered'].includes(e.name)
  );
  assert.equal(light.length, 4);
  const effective = {};
  for (const e of light) effective[e.id] = 'untrained';
  effective['armor/padded'] = 'proficient';
  effective['armor/leather'] = 'proficient';
  effective['armor/studded'] = 'proficient';

  const result = summarizeRmeProficiencies(light, picture({}, {}, effective));

  assert.deepEqual(result.armor, [
    { kind: 'item', label: 'Leather', level: 'proficient' },
    { kind: 'item', label: 'Padded', level: 'proficient' },
    { kind: 'item', label: 'Studded', level: 'proficient' },
  ]);
  assert.deepEqual(result.weapons, []);
});

test('weapons: three of four group members proficient with no group grant -> three individual rows', () => {
  const fourBows = byGroup('Bows').slice(0, 4);
  assert.equal(fourBows.length, 4);
  const effective = {};
  for (const e of fourBows) effective[e.id] = 'untrained';
  effective[fourBows[0].id] = 'proficient';
  effective[fourBows[1].id] = 'proficient';
  effective[fourBows[2].id] = 'proficient';

  const result = summarizeRmeProficiencies(fourBows, picture({}, {}, effective));

  assert.deepEqual(result.armor, []);
  assert.deepEqual(result.weapons, [
    { kind: 'item', label: fourBows[0].name, level: 'proficient' },
    { kind: 'item', label: fourBows[1].name, level: 'proficient' },
    { kind: 'item', label: fourBows[2].name, level: 'proficient' },
  ]);
});

// ---------------------------------------------------------------------------
// Natural weapons
// ---------------------------------------------------------------------------

test('natural: no grants produce only the natural-weapons default category', () => {
  // An empty actor with no training state - only the natural default applies.
  const actor = { getFlag() { return undefined; }, items: [] };
  const pictureResult = computeActorTraining(actor, equipment);
  const result = summarizeRmeProficiencies(equipment, pictureResult);

  assert.deepEqual(result.armor, []);
  assert.deepEqual(result.weapons, [
    { kind: 'category', label: 'Natural Weapons', level: 'proficient', exceptions: [{ label: 'Unarmed Strike', level: 'untrained' }] },
  ]);
});

test('natural: default seven proficient with unarmed untrained', () => {
  const naturals = byGroup('Natural Weapons');
  const effective = {};
  for (const e of naturals) effective[e.id] = e.id === 'natural-weapons/unarmed-strike' ? 'untrained' : 'proficient';

  const result = summarizeRmeProficiencies(naturals, picture({}, {}, effective));

  assert.deepEqual(result.weapons, [
    { kind: 'category', label: 'Natural Weapons', level: 'proficient', exceptions: [{ label: 'Unarmed Strike', level: 'untrained' }] },
  ]);
});

test('natural: all seven expert with unarmed untrained -> expert category with untrained exception', () => {
  const naturals = byGroup('Natural Weapons');
  const effective = {};
  for (const e of naturals) effective[e.id] = e.id === 'natural-weapons/unarmed-strike' ? 'untrained' : 'expert';

  const result = summarizeRmeProficiencies(naturals, picture({}, {}, effective));

  assert.deepEqual(result.weapons, [
    { kind: 'category', label: 'Natural Weapons', level: 'expert', exceptions: [{ label: 'Unarmed Strike', level: 'untrained' }] },
  ]);
});

// ---------------------------------------------------------------------------
// Basic tier is not Proficient
// ---------------------------------------------------------------------------

test('basic: a basic-only group produces no positive category or items', () => {
  const firearms = byGroup('Firearms');
  const effective = {};
  for (const e of firearms) effective[e.id] = 'basic';

  const result = summarizeRmeProficiencies(firearms, picture({}, {}, effective));

  assert.deepEqual(result.armor, []);
  assert.deepEqual(result.weapons, []);
});

test('basic: a proficient group with one basic item yields proficient category and a basic exception', () => {
  const firearms = byGroup('Firearms');
  const effective = {};
  for (const e of firearms) effective[e.id] = 'proficient';
  effective['firearms/bolt-action-rifle'] = 'basic';

  const result = summarizeRmeProficiencies(
    firearms,
    picture({ groups: { Firearms: 'proficient' } }, {}, effective)
  );

  assert.deepEqual(result.weapons, [
    { kind: 'category', label: 'Firearms', level: 'proficient', exceptions: [{ label: 'Bolt-Action Rifle', level: 'basic' }] },
  ]);
});

test('basic: mixed basic/expert with no group grant emits only the expert item', () => {
  const firearms = byGroup('Firearms');
  const effective = {};
  for (const e of firearms) effective[e.id] = 'basic';
  effective['firearms/bolt-action-rifle'] = 'expert';

  const result = summarizeRmeProficiencies(firearms, picture({}, {}, effective));

  assert.deepEqual(result.weapons, [
    { kind: 'item', label: 'Bolt-Action Rifle', level: 'expert' },
  ]);
});

// ---------------------------------------------------------------------------
// Determinism / duplicates / no mutation
// ---------------------------------------------------------------------------

test('summary: deterministic output, no duplicate rows, and no input mutation', () => {
  const firearms = byGroup('Firearms');
  const rifle = entry('firearms/bolt-action-rifle');
  const equipWithDuplicate = [...firearms, rifle];

  const effective = {};
  for (const e of firearms) effective[e.id] = 'proficient';
  effective[rifle.id] = 'expert';

  const manual = { groups: { Firearms: 'proficient' } };
  const manualBefore = deepClone(manual);
  const effectiveBefore = deepClone(effective);
  const equipBefore = deepClone(equipWithDuplicate);
  const pictureBefore = { manual, derived: {}, effective: { items: effective } };

  const first = summarizeRmeProficiencies(equipWithDuplicate, pictureBefore);
  const second = summarizeRmeProficiencies(equipWithDuplicate, pictureBefore);

  assert.deepEqual(second, first);
  // The duplicated rifle entry does not fan out a second category/item row.
  assert.equal(first.weapons.length, 2);
  assert.deepEqual(first.weapons, [
    { kind: 'category', label: 'Firearms', level: 'proficient', exceptions: [{ label: 'Bolt-Action Rifle', level: 'expert' }] },
    { kind: 'item', label: 'Bolt-Action Rifle', level: 'expert' },
  ]);

  assert.deepEqual(manual, manualBefore);
  assert.deepEqual(effective, effectiveBefore);
  assert.deepEqual(equipWithDuplicate, equipBefore);
});
