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
// `sources` is the optional derivation source list (defaults to none).
function picture(manual, derived, items, sources = []) {
  return {
    manual,
    derived,
    gaps: [],
    sources,
    effective: { items },
  };
}

// Build a single-class actor picture through the real `computeActorTraining`, so
// the class-source grants and effective levels come from the real derivation.
function classActor(classId) {
  const name = classId[0].toUpperCase() + classId.slice(1);
  const item = {
    id: classId,
    type: 'class',
    name,
    system: { classIdentifier: classId, advancement: [] },
  };
  const actor = {
    system: { details: { originalClass: classId } },
    items: [item],
    getFlag() {
      return undefined;
    },
  };
  return computeActorTraining(actor, equipment);
}

// Build a two-class actor (original + secondary) through the real
// `computeActorTraining`, so the original/secondary split and the source grants
// come from the real derivation. `deriveActorTraining` strips the internal
// `multiclass` flag from sources, so the returned sources carry only `type`.
function multiclassActor(originalId, secondaryId) {
  const mk = (classId) => {
    const name = classId[0].toUpperCase() + classId.slice(1);
    return {
      id: classId,
      type: 'class',
      name,
      system: { classIdentifier: classId, advancement: [] },
    };
  };
  return {
    system: { details: { originalClass: originalId } },
    items: [mk(originalId), mk(secondaryId)],
    getFlag() {
      return undefined;
    },
  };
}

// ---------------------------------------------------------------------------
// Class source grouping checks (used by the all-13-class table regression)
// ---------------------------------------------------------------------------

function isPositiveLevel(level) {
  return level === 'proficient' || level === 'expert';
}

// The weapon group labels that appear as a positive summary category row. An
// item whose catalog group is in this set is covered by that category and must
// never be duplicated into a class row.
function positiveWeaponCategoryLabels(weapons) {
  return new Set(weapons.filter((w) => w.kind === 'category').map((w) => w.label));
}

// The direct weapon grants carried by `type: 'class'` sources that are
// effective-positive and whose catalog group has no positive summary category.
// The summary must surface every one of these exactly once across `kind:
// 'class'` rows and never as a standalone item or a category exception.
function classLeftoverWeaponGrants(pictureResult, categoryLabels) {
  const byId = new Map(equipment.filter((e) => e.id).map((e) => [e.id, e]));
  const leftovers = [];
  for (const source of pictureResult.sources.filter((s) => s.type === 'class')) {
    for (const [id] of Object.entries(source.grants.items || {})) {
      const entry = byId.get(id);
      if (!entry || entry.kind !== 'weapon') continue;
      if (categoryLabels.has(entry.group)) continue;
      const effective = pictureResult.effective.items[id];
      if (!isPositiveLevel(effective)) continue;
      leftovers.push({
        sourceId: source.id,
        sourceLabel: source.label,
        id,
        name: entry.name,
        level: effective,
      });
    }
  }
  return leftovers;
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

// ---------------------------------------------------------------------------
// Class-origin direct weapon grants (kind: 'class' rows)
// ---------------------------------------------------------------------------

test('class: rogue class row plus Dueling Blades catalog row through computeActorTraining', () => {
  const result = summarizeRmeProficiencies(equipment, classActor('rogue'));

  // Armor: rogue grants only light armor.
  assert.deepEqual(result.armor, [
    { kind: 'category', label: 'Light Armor', level: 'proficient', exceptions: [] },
  ]);

  // Categories come first (alphabetically), then the class row.
  assert.deepEqual(
    result.weapons.map((w) => w.kind),
    ['category', 'category', 'category', 'class']
  );
  assert.equal(result.weapons[0].label, 'Bludgeons');
  assert.equal(result.weapons[1].label, 'Dueling Blades');
  assert.equal(result.weapons[2].label, 'Natural Weapons');

  const rogueRow = result.weapons[3];
  assert.equal(rogueRow.kind, 'class');
  assert.equal(rogueRow.label, 'Rogue Weapons');
  assert.equal(rogueRow.level, 'proficient');
  assert.ok(rogueRow.items.length > 0);

  // Dueling Blades catalog items are covered by the Dueling Blades category, so
  // they are not duplicated into the class row.
  const duelingNames = new Set(byGroup('Dueling Blades').map((e) => e.name));
  assert.ok(rogueRow.items.every((it) => !duelingNames.has(it.label)));
  assert.ok(rogueRow.items.some((it) => it.label === 'Shortbow'));
});

test('class: cleric Weapons row and Shields category excluding the Clockwork shield', () => {
  const result = summarizeRmeProficiencies(equipment, classActor('cleric'));

  // Armor: light + medium armor categories plus a class-derived Shields
  // category. No standalone armor items.
  assert.ok(result.armor.every((row) => row.kind === 'category'));
  const shieldCat = result.armor.find((row) => row.kind === 'category' && row.label === 'Shields');
  assert.ok(shieldCat, 'expected a Shields category for a class granting 7/8 shields');
  assert.equal(shieldCat.level, 'proficient');

  const exceptionLabels = new Set(shieldCat.exceptions.map((e) => e.label));
  const diskarmor = shieldCat.exceptions.find((e) => e.label === 'Diskarmor');
  assert.equal(diskarmor.level, 'untrained');
  // The Clockwork shield is excluded from the grant; every other shield is
  // covered by the category (no exception).
  for (const shield of byKind('shield')) {
    if (shield.name === 'Diskarmor') continue;
    assert.ok(!exceptionLabels.has(shield.name), `${shield.name} should be covered by the category`);
  }

  const clericRow = result.weapons.find((w) => w.kind === 'class');
  assert.ok(clericRow, 'expected a Cleric Weapons class row');
  assert.equal(clericRow.label, 'Cleric Weapons');
  assert.equal(clericRow.level, 'proficient');
  assert.ok(clericRow.items.some((it) => it.label === 'Shortbow'));
});

// ---------------------------------------------------------------------------
// Class shields: 7/8 grant, manual suppression, isolated grant
// ---------------------------------------------------------------------------

function shieldGrantSource(grantedShields) {
  return [
    {
      id: 'cleric',
      label: 'Cleric',
      type: 'class',
      grants: {
        groups: {},
        items: Object.fromEntries(grantedShields.map((s) => [s.id, 'proficient'])),
      },
    },
  ];
}

test('class shields: a 7/8 grant with one shield manually suppressed still yields a Shields category', () => {
  const shields = byKind('shield');
  const granted = shields.slice(0, 7);
  const unGranted = shields[7];
  const suppressed = granted[0];

  const effective = {};
  for (const s of shields) effective[s.id] = 'untrained';
  for (const s of granted) effective[s.id] = 'proficient';
  effective[suppressed.id] = 'untrained';

  const result = summarizeRmeProficiencies(
    shields,
    picture({ items: { [suppressed.id]: 'untrained' }, groups: {} }, {}, effective, shieldGrantSource(granted))
  );

  assert.equal(result.armor.length, 1);
  const cat = result.armor[0];
  assert.equal(cat.kind, 'category');
  assert.equal(cat.label, 'Shields');
  assert.equal(cat.level, 'proficient');

  const labels = new Set(cat.exceptions.map((e) => e.label));
  assert.ok(labels.has(suppressed.name), 'the manually suppressed shield must be an exception');
  assert.ok(labels.has(unGranted.name), 'the un-granted (Clockwork) shield must be an exception');
});

test('class shields: manual suppress-all produces no Shields category', () => {
  const shields = byKind('shield');
  const granted = shields.slice(0, 7);
  const effective = {};
  for (const s of shields) effective[s.id] = 'untrained';

  const result = summarizeRmeProficiencies(
    shields,
    picture({ groups: { Shields: 'untrained' } }, {}, effective, shieldGrantSource(granted))
  );

  assert.deepEqual(result.armor, []);
});

test('class shields: manual group untrained suppresses class-derived category and emits only positive overrides', () => {
  const shields = byKind('shield');
  const granted = shields.slice(0, 7);
  const overrides = granted.slice(0, 4);

  const effective = {};
  for (const s of shields) effective[s.id] = 'untrained';
  for (const s of overrides) effective[s.id] = 'proficient';

  const result = summarizeRmeProficiencies(
    shields,
    picture({ groups: { Shields: 'untrained' } }, {}, effective, shieldGrantSource(granted))
  );

  // A 7/8 cleric-style grant would normally produce a class-derived Shields
  // category, but the explicit manual untrained group overrides it. Only the
  // four item-specific proficient overrides are reported, sorted alphabetically.
  assert.deepEqual(result.armor, [
    { kind: 'item', label: 'Arm Guard', level: 'proficient' },
    { kind: 'item', label: 'Buckler', level: 'proficient' },
    { kind: 'item', label: 'Diskarmor', level: 'proficient' },
    { kind: 'item', label: 'Skirmish', level: 'proficient' },
  ]);
});

test('class shields: manual group basic also suppresses class-derived category', () => {
  const shields = byKind('shield');
  const granted = shields.slice(0, 7);
  const overrides = granted.slice(0, 4);

  const effective = {};
  for (const s of shields) effective[s.id] = 'untrained';
  for (const s of overrides) effective[s.id] = 'proficient';

  const result = summarizeRmeProficiencies(
    shields,
    picture({ groups: { Shields: 'basic' } }, {}, effective, shieldGrantSource(granted))
  );

  // 'basic' is a nonpositive manual group state, so it must suppress the
  // class-derived category just like 'untrained'.
  assert.deepEqual(result.armor, [
    { kind: 'item', label: 'Arm Guard', level: 'proficient' },
    { kind: 'item', label: 'Buckler', level: 'proficient' },
    { kind: 'item', label: 'Diskarmor', level: 'proficient' },
    { kind: 'item', label: 'Skirmish', level: 'proficient' },
  ]);
});

test('class shields: an isolated shield grant does not create a false Shields category', () => {
  const shields = byKind('shield');
  const one = shields[0];
  const effective = {};
  for (const s of shields) effective[s.id] = 'untrained';
  effective[one.id] = 'proficient';

  const source = [
    { id: 'armorer', label: 'Armorer', type: 'class', grants: { groups: {}, items: { [one.id]: 'proficient' } } },
  ];
  const result = summarizeRmeProficiencies(shields, picture({}, {}, effective, source));

  assert.deepEqual(result.armor, [{ kind: 'item', label: one.name, level: 'proficient' }]);
});

// ---------------------------------------------------------------------------
// Class row dedupe / direct-grant scope / mixed tiers
// ---------------------------------------------------------------------------

test('class: overlapping class sources de-duplicate item ids by first source', () => {
  const axes = byGroup('Axes');
  const bows = byGroup('Bows');
  const sub = [...axes, ...bows];

  const effective = {};
  for (const e of sub) effective[e.id] = 'untrained';
  effective['axes/battle-axe'] = 'proficient';
  effective['bows/longbow'] = 'proficient';

  const sources = [
    { id: 'a', label: 'Alpha', type: 'class', grants: { groups: {}, items: { 'axes/battle-axe': 'proficient' } } },
    {
      id: 'b',
      label: 'Beta',
      type: 'class',
      grants: { groups: {}, items: { 'axes/battle-axe': 'proficient', 'bows/longbow': 'proficient' } },
    },
  ];

  const result = summarizeRmeProficiencies(sub, picture({}, {}, effective, sources));

  assert.equal(result.weapons.length, 2);
  assert.deepEqual(result.weapons[0], {
    kind: 'class',
    label: 'Alpha Weapons',
    level: 'proficient',
    items: [{ label: 'Battle Axe', level: 'proficient' }],
  });
  // Battle Axe is claimed by the first source; the second source keeps only its
  // own direct grant (Longbow).
  assert.deepEqual(result.weapons[1], {
    kind: 'class',
    label: 'Beta Weapons',
    level: 'proficient',
    items: [{ label: 'Longbow', level: 'proficient' }],
  });
});

test('class: a class-only mixed expert/proficient group yields a null header and actual child tiers', () => {
  const axes = byGroup('Axes');
  const bows = byGroup('Bows');
  const sub = [...axes, ...bows];

  const effective = {};
  for (const e of sub) effective[e.id] = 'untrained';
  effective['axes/battle-axe'] = 'expert';
  effective['bows/longbow'] = 'proficient';

  const sources = [
    {
      id: 'blademaster',
      label: 'Blademaster',
      type: 'class',
      grants: { groups: {}, items: { 'axes/battle-axe': 'proficient', 'bows/longbow': 'proficient' } },
    },
  ];

  const result = summarizeRmeProficiencies(sub, picture({}, {}, effective, sources));

  assert.deepEqual(result.weapons, [
    {
      kind: 'class',
      label: 'Blademaster Weapons',
      level: null,
      items: [
        { label: 'Battle Axe', level: 'expert' },
        { label: 'Longbow', level: 'proficient' },
      ],
    },
  ]);
});

test('class: a class row reflects only direct item grants, not all catalog items in a group', () => {
  const axes = byGroup('Axes');
  const effective = {};
  for (const e of axes) effective[e.id] = 'untrained';
  effective['axes/battle-axe'] = 'proficient';
  effective['axes/greataxe'] = 'proficient';

  const sources = [
    { id: 'champion', label: 'Champion', type: 'class', grants: { groups: {}, items: { 'axes/battle-axe': 'proficient' } } },
  ];

  const result = summarizeRmeProficiencies(axes, picture({}, {}, effective, sources));

  // Greataxe is positive but not directly granted by the class, so it must not
  // appear in the class row; it is reported as a standalone item instead.
  assert.deepEqual(result.weapons, [
    {
      kind: 'class',
      label: 'Champion Weapons',
      level: 'proficient',
      items: [{ label: 'Battle Axe', level: 'proficient' }],
    },
    { kind: 'item', label: 'Greataxe', level: 'proficient' },
  ]);
});

// ---------------------------------------------------------------------------
// Category-first ordering
// ---------------------------------------------------------------------------

test('order: catalog categories precede standalone individual weapons', () => {
  const firearms = byGroup('Firearms');
  const axes = byGroup('Axes');
  const sub = [...firearms, ...axes];

  const effective = {};
  for (const e of sub) effective[e.id] = 'untrained';
  for (const e of firearms) effective[e.id] = 'proficient';
  effective['axes/battle-axe'] = 'proficient';

  const result = summarizeRmeProficiencies(
    sub,
    picture({ groups: { Firearms: 'proficient' } }, {}, effective)
  );

  assert.equal(result.weapons[0].kind, 'category');
  assert.equal(result.weapons[0].label, 'Firearms');
  assert.equal(result.weapons[1].kind, 'item');
  assert.equal(result.weapons[1].label, 'Battle Axe');
});

test('order: armor categories precede standalone armor items', () => {
  const armors = byKind('armor');
  const allShields = byKind('shield');
  const oneShield = allShields[0];
  const sub = [...armors, ...allShields];

  const effective = {};
  for (const e of sub) effective[e.id] = 'untrained';
  for (const e of armors) effective[e.id] = 'proficient';
  effective[oneShield.id] = 'proficient';

  const result = summarizeRmeProficiencies(sub, picture({}, {}, effective));

  const armorKinds = result.armor.map((row) => row.kind);
  assert.deepEqual(armorKinds, ['category', 'category', 'category', 'item']);
  assert.ok(result.armor[0].label < result.armor[1].label);
  assert.equal(result.armor[3].kind, 'item');
  assert.equal(result.armor[3].label, oneShield.name);
});

// ---------------------------------------------------------------------------
// Table regression: all 13 starting classes and the Shields category threshold
// ---------------------------------------------------------------------------

test('class: table regression for all 13 starting classes - Shields category by grant threshold and class source grouping', () => {
  // A class grants >= half of the 8 catalog shields (>= 4, and in the shipped
  // table 7 or 8 via 'all' / 'no-clockwork'); a class granting none never gets a
  // category. The multiclass grants differ from these starting grants, so this
  // table only covers the single-class starting grants.
  const expected = {
    artificer: true,
    barbarian: true,
    bard: false,
    cleric: true,
    druid: true,
    fighter: true,
    monk: false,
    paladin: true,
    ranger: true,
    rogue: false,
    sorcerer: false,
    warlock: false,
    wizard: false,
  };

  for (const [classId, expectShields] of Object.entries(expected)) {
    const pictureResult = classActor(classId);
    const result = summarizeRmeProficiencies(equipment, pictureResult);

    // --- Existing shields threshold expectation ---
    const hasShields = result.armor.some((row) => row.kind === 'category' && row.label === 'Shields');
    assert.equal(hasShields, expectShields, `${classId}: unexpected Shields category`);

    // --- Class source grouping ---
    const categoryLabels = positiveWeaponCategoryLabels(result.weapons);
    const leftovers = classLeftoverWeaponGrants(pictureResult, categoryLabels);
    const classRows = result.weapons.filter((w) => w.kind === 'class');

    // Every leftover source-granted effective-positive weapon must appear exactly
    // once across class rows, and never as a standalone item or a positive
    // category exception (which would duplicate the class row).
    const classRowItemCount = new Map();
    for (const row of classRows) {
      for (const item of row.items) {
        classRowItemCount.set(item.label, (classRowItemCount.get(item.label) || 0) + 1);
      }
    }
    const itemRowLabels = new Set();
    for (const w of result.weapons) {
      if (w.kind === 'item') {
        itemRowLabels.add(w.label);
      } else if (w.kind === 'category') {
        for (const e of w.exceptions || []) {
          if (isPositiveLevel(e.level)) itemRowLabels.add(e.label);
        }
      }
    }
    for (const leftover of leftovers) {
      assert.equal(
        classRowItemCount.get(leftover.name),
        1,
        `${classId}: ${leftover.name} must appear exactly once across class rows`
      );
      assert.ok(
        !itemRowLabels.has(leftover.name),
        `${classId}: ${leftover.name} must not be a standalone item or category exception`
      );
    }

    // Class rows only carry positive items whose level matches the effective
    // per-item training level.
    for (const row of classRows) {
      for (const item of row.items) {
        const we = equipment.find((e) => e.kind === 'weapon' && e.name === item.label);
        assert.ok(we, `${classId}: unknown weapon in class row ${item.label}`);
        const effective = pictureResult.effective.items[we.id];
        assert.ok(isPositiveLevel(effective), `${classId}: class row item ${item.label} is not effective-positive`);
        assert.equal(item.level, effective, `${classId}: class row item ${item.label} level mismatch`);
      }
    }

    // A class source with leftover direct grants must produce exactly one class
    // row labeled from that source; a class/source with no leftover grants must
    // not produce a false class row.
    const leftoverSourceLabels = new Set(leftovers.map((l) => l.sourceLabel));
    for (const label of leftoverSourceLabels) {
      const matching = classRows.filter((r) => r.label === `${label} Weapons`);
      assert.equal(matching.length, 1, `${classId}: expected exactly one ${label} Weapons class row`);
    }
    assert.equal(
      classRows.length,
      leftoverSourceLabels.size,
      `${classId}: class row count must match sources with leftover direct grants`
    );

    // Category rows precede class rows which precede standalone items. A category
    // must never follow a class row or a standalone item, and a class row must
    // never follow a standalone item.
    let seenClass = false;
    let seenStandalone = false;
    for (const w of result.weapons) {
      if (w.kind === 'category') {
        assert.ok(!seenClass && !seenStandalone, `${classId}: category row out of order`);
      } else if (w.kind === 'class') {
        assert.ok(!seenStandalone, `${classId}: class row after standalone item`);
        seenClass = true;
      } else if (w.kind === 'item') {
        // Before any class row an item is a category exception; after it is a
        // standalone item.
        if (seenClass) seenStandalone = true;
      }
    }
  }
});

test('class: multiclass Shields category for rogue first plus each secondary class - source grant threshold only', () => {
  // Rogue starts with no shields, and the multiclass grants differ from the
  // single-class starting grants. We do not assert any particular multiclass
  // weapon category choice (barbarian/fighter/paladin/ranger require a 4-group
  // choice, but the fixed armor/shield grants are independent of it). A shield
  // id granted by more than one class source is counted once (possible source
  // overlap), though the original rogue contributes none here.
  const shieldThreshold = Math.ceil(byKind('shield').length / 2);
  const secondaryClasses = [
    'artificer',
    'barbarian',
    'bard',
    'cleric',
    'druid',
    'fighter',
    'monk',
    'paladin',
    'ranger',
    'sorcerer',
    'warlock',
    'wizard',
  ];

  for (const secondary of secondaryClasses) {
    const pictureResult = computeActorTraining(multiclassActor('rogue', secondary), equipment);
    const result = summarizeRmeProficiencies(equipment, pictureResult);

    // Count shield ids granted by class sources at a positive level.
    const sourceShieldIds = new Set();
    for (const source of pictureResult.sources.filter((s) => s.type === 'class')) {
      for (const [id, level] of Object.entries(source.grants.items || {})) {
        const e = entry(id);
        if (e.kind === 'shield' && isPositiveLevel(level)) sourceShieldIds.add(id);
      }
    }

    const hasShieldCategory = result.armor.some(
      (row) => row.kind === 'category' && row.label === 'Shields'
    );
    assert.equal(
      hasShieldCategory,
      sourceShieldIds.size >= shieldThreshold,
      `${secondary}: Shields category must appear iff class sources grant at least ${shieldThreshold} shields`
    );
  }
});
