import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  CLASS_IDS,
  eligibleGroups,
  classGrants,
  multiclassGrants,
} from '../src/class-training.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const catalog = JSON.parse(
  readFileSync(join(__dirname, '..', 'data', 'catalog.json'), 'utf8')
);
const equipment = catalog.equipment;
const byId = new Map(equipment.map((e) => [e.id, e]));

function grants(id, chosenGroups, options) {
  return classGrants(id, equipment, chosenGroups || [], options);
}

function mg(id, chosenGroups) {
  return multiclassGrants(id, equipment, chosenGroups || []);
}

function hasItem(g, id) {
  return Object.prototype.hasOwnProperty.call(g.items, id);
}

function hasGroup(g, group) {
  return Object.prototype.hasOwnProperty.call(g.groups, group);
}

function itemIds(g, kind) {
  return Object.keys(g.items).filter((id) => byId.get(id)?.kind === kind);
}

// All weapon group names in the catalog (kind === 'weapon'), sorted, that can be
// chosen by a class with no group restriction.
const ALL_WEAPON_GROUPS = [
  'Ambush Weapons',
  'Axes',
  'Bludgeons',
  'Bows',
  'Combat Blades',
  'Crossbows',
  'Dueling Blades',
  'Firearms',
  'Flails',
  'Hammers Picks',
  'Launch Weapons',
  'Polearms',
  'Spears',
  'Throwing Weapons',
  'Whips',
].sort();

// ---------------------------------------------------------------------------
// CLASS_IDS
// ---------------------------------------------------------------------------

test('CLASS_IDS lists the 13 classes in lowercase', () => {
  assert.deepEqual(CLASS_IDS, [
    'artificer',
    'barbarian',
    'bard',
    'cleric',
    'druid',
    'fighter',
    'monk',
    'paladin',
    'ranger',
    'rogue',
    'sorcerer',
    'warlock',
    'wizard',
  ]);
});

// ---------------------------------------------------------------------------
// eligibleGroups
// ---------------------------------------------------------------------------

test('eligibleGroups: a class with no group restriction sees all weapon groups', () => {
  assert.deepEqual(eligibleGroups('fighter', equipment), ALL_WEAPON_GROUPS);
  assert.deepEqual(eligibleGroups('cleric', equipment), ALL_WEAPON_GROUPS);
  assert.deepEqual(eligibleGroups('druid', equipment), ALL_WEAPON_GROUPS);
});

test('eligibleGroups: never includes Armor, Shields or Natural Weapons', () => {
  const groups = eligibleGroups('fighter', equipment);
  assert.ok(!groups.includes('Armor'));
  assert.ok(!groups.includes('Shields'));
  assert.ok(!groups.includes('Natural Weapons'));
});

test('eligibleGroups: barbarian excludes Firearms and Crossbows', () => {
  const groups = eligibleGroups('barbarian', equipment);
  assert.equal(groups.length, 13);
  assert.ok(!groups.includes('Firearms'));
  assert.ok(!groups.includes('Crossbows'));
  assert.ok(groups.includes('Bows'));
  // Removing the two groups keeps the count within the 15 weapon groups.
  assert.equal(groups.length, ALL_WEAPON_GROUPS.length - 2);
});

test('eligibleGroups: paladin excludes Firearms and Throwing Weapons', () => {
  const groups = eligibleGroups('paladin', equipment);
  assert.ok(!groups.includes('Firearms'));
  assert.ok(!groups.includes('Throwing Weapons'));
  assert.equal(groups.length, ALL_WEAPON_GROUPS.length - 2);
});

test('eligibleGroups: ranger excludes Polearms and Flails', () => {
  const groups = eligibleGroups('ranger', equipment);
  assert.ok(!groups.includes('Polearms'));
  assert.ok(!groups.includes('Flails'));
  assert.equal(groups.length, ALL_WEAPON_GROUPS.length - 2);
});

test('eligibleGroups: property exclusions do not remove a category', () => {
  // Bows contain Clockwork weapons (collapsible-bow, compound-bow), but the
  // category stays selectable for barbarian and ranger; only the items are cut.
  assert.ok(eligibleGroups('barbarian', equipment).includes('Bows'));
  assert.ok(eligibleGroups('ranger', equipment).includes('Bows'));
  // Ambush Weapons contains Conceal weapons; paladin keeps the category.
  assert.ok(eligibleGroups('paladin', equipment).includes('Ambush Weapons'));
});

test('eligibleGroups: an unknown class throws', () => {
  assert.throws(() => eligibleGroups('bardz', equipment), /Unknown class/);
});

// ---------------------------------------------------------------------------
// Simple vs Awkward (rules/Introduction.md)
// ---------------------------------------------------------------------------

// Simple weapons are `kind === 'weapon'` entries whose Untrained tier lacks the
// Awkward property. Martial weapons carry "Awkward" at Untrained, including
// source rows written without a space ("UntrainedAwkward", "UntrainedOne-Handed").
test('classGrants: cleric simple grants include only non-Awkward weapons', () => {
  const g = grants('cleric');
  // Simple: no Awkward at Untrained.
  assert.ok(hasItem(g, 'dueling-blades/kukri'));
  assert.ok(hasItem(g, 'dueling-blades/shortsword'));
  assert.ok(hasItem(g, 'axes/handaxe'));
  assert.ok(hasItem(g, 'crossbows/light-crossbow'));
  // Martial: Awkward at Untrained.
  assert.ok(!hasItem(g, 'axes/battle-axe'));
  assert.ok(!hasItem(g, 'combat-blades/longsword'));
  assert.ok(!hasItem(g, 'crossbows/mauler'));
  assert.ok(!hasItem(g, 'spears/trident'));
});

test('classGrants: untrained rows without whitespace are handled correctly', () => {
  const g = grants('cleric');
  // "UntrainedOne-Handed, ..." (kukri, sickle) are simple, no Awkward.
  assert.ok(hasItem(g, 'dueling-blades/kukri'));
  assert.ok(hasItem(g, 'dueling-blades/sickle'));
  // "UntrainedAwkward, ..." (sword-breaker, lajatang, harpoon) are martial.
  assert.ok(!hasItem(g, 'dueling-blades/sword-breaker'));
  assert.ok(!hasItem(g, 'polearms/lajatang'));
  assert.ok(!hasItem(g, 'spears/harpoon'));
});

test('classGrants: cleric grants exactly the 52 simple weapons', () => {
  const g = grants('cleric');
  const weapons = itemIds(g, 'weapon');
  assert.equal(weapons.length, 52);
});

test('classGrants: monk one-handed simple excludes two-handed and martial', () => {
  const g = grants('monk');
  assert.ok(hasItem(g, 'dueling-blades/sickle'));
  assert.ok(hasItem(g, 'dueling-blades/shortsword'));
  assert.ok(hasItem(g, 'axes/kama'));
  assert.ok(hasItem(g, 'bludgeons/mallet'));
  // Two-handed or martial weapons are not one-handed simple.
  assert.ok(!hasItem(g, 'bludgeons/quarterstaff'));
  assert.ok(!hasItem(g, 'axes/battle-axe'));
  assert.ok(!hasItem(g, 'dueling-blades/cutlass'));
  assert.ok(!hasItem(g, 'bows/shortbow'));
});

// ---------------------------------------------------------------------------
// Per-class fixed grants
// ---------------------------------------------------------------------------

test('classGrants: monk grants are all one-handed simple weapons plus shortsword', () => {
  const g = grants('monk');
  const weapons = itemIds(g, 'weapon');
  assert.equal(weapons.length, 31);
  assert.ok(hasItem(g, 'dueling-blades/shortsword'));
  // No armor or shields for monk.
  assert.equal(itemIds(g, 'armor').length, 0);
  assert.equal(itemIds(g, 'shield').length, 0);
});

test('classGrants: artificer hands out Crossbows/Firearms groups and Clockwork weapons', () => {
  const g = grants('artificer');
  assert.equal(g.groups.Crossbows, 'proficient');
  assert.equal(g.groups.Firearms, 'proficient');
  assert.ok(hasItem(g, 'whips/whip-sword'));
  assert.ok(hasItem(g, 'ambush-weapons/hidden-blade'));
  // Not simple, not Clockwork, not in a granted group -> not granted.
  assert.ok(!hasItem(g, 'ambush-weapons/cane-sword'));
  // Artificer medium + light armor and all shields (no Clockwork restriction).
  assert.equal(itemIds(g, 'armor').length, 8);
  assert.equal(itemIds(g, 'shield').length, 8);
  assert.ok(hasItem(g, 'shields/diskarmor'));
});

test('classGrants: bard grants Dueling Blades/Throwing Weapons and the three named weapons', () => {
  const g = grants('bard');
  assert.equal(g.groups['Dueling Blades'], 'proficient');
  assert.equal(g.groups['Throwing Weapons'], 'proficient');
  assert.ok(hasItem(g, 'ambush-weapons/interceptor'));
  assert.ok(hasItem(g, 'combat-blades/longsword'));
  assert.ok(hasItem(g, 'combat-blades/scimitar'));
  // Light armor only.
  const armor = itemIds(g, 'armor').map((id) => byId.get(id).name);
  assert.deepEqual(armor.sort(), ['Lacquered', 'Leather', 'Padded', 'Studded']);
  assert.equal(itemIds(g, 'shield').length, 0);
});

test('classGrants: rogue grants Dueling Blades and every Conceal weapon', () => {
  const g = grants('rogue');
  assert.equal(g.groups['Dueling Blades'], 'proficient');
  // Conceal weapons from outside the Dueling Blades group.
  assert.ok(hasItem(g, 'crossbows/hidden-crossbow'));
  assert.ok(hasItem(g, 'throwing-weapons/throwing-knife'));
  assert.ok(hasItem(g, 'launch-weapons/blowgun'));
  // Conceal Dueling Blades are enumerated as items; non-Conceal martial blades
  // (e.g. rapier) are only covered by the granted Dueling Blades group, so they
  // are never emitted as individual items.
  assert.ok(hasItem(g, 'dueling-blades/sai'));
  assert.ok(!hasItem(g, 'dueling-blades/rapier'));
});

test('classGrants: druid grants the five categories minus Clockwork and the named weapons', () => {
  const g = grants('druid');
  assert.deepEqual(g.groups, {});
  // Ambush Weapons minus Clockwork (compass-blade, hidden-blade cut).
  assert.ok(hasItem(g, 'ambush-weapons/cane-sword'));
  assert.ok(!hasItem(g, 'ambush-weapons/compass-blade'));
  assert.ok(!hasItem(g, 'ambush-weapons/hidden-blade'));
  // Named weapons.
  assert.ok(hasItem(g, 'dueling-blades/dagger'));
  assert.ok(hasItem(g, 'dueling-blades/kukri'));
  assert.ok(hasItem(g, 'combat-blades/scimitar'));
  assert.ok(hasItem(g, 'dueling-blades/sickle'));
  assert.ok(hasItem(g, 'axes/tomahawk'));
  assert.ok(hasItem(g, 'polearms/war-scythe'));
  assert.ok(hasItem(g, 'hammers-picks/wall-pick'));
  assert.ok(hasItem(g, 'whips/whip'));
  // Medium + light armor, all shields (druid has no Clockwork shield restriction).
  assert.equal(itemIds(g, 'armor').length, 8);
  assert.equal(itemIds(g, 'shield').length, 8);
  assert.ok(hasItem(g, 'shields/diskarmor'));
});

test('classGrants: warlock is simple weapons plus light armor', () => {
  const g = grants('warlock');
  assert.deepEqual(g.groups, {});
  assert.equal(itemIds(g, 'weapon').length, 52);
  assert.equal(itemIds(g, 'armor').length, 4);
  assert.equal(itemIds(g, 'shield').length, 0);
});

test('classGrants: sorcerer and wizard grant nothing', () => {
  assert.deepEqual(grants('sorcerer'), { groups: {}, items: {} });
  assert.deepEqual(grants('wizard'), { groups: {}, items: {} });
});

// ---------------------------------------------------------------------------
// Category choice classes: 8 categories, exclusions, validation
// ---------------------------------------------------------------------------

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

// Ranger cannot pick Polearms or Flails, so substitute allowed categories.
const RANGER_EIGHT = [
  'Axes',
  'Bows',
  'Combat Blades',
  'Crossbows',
  'Dueling Blades',
  'Hammers Picks',
  'Spears',
  'Whips',
];

test('classGrants: fighter grants the chosen categories as groups', () => {
  const g = grants('fighter', EIGHT);
  const expected = {};
  for (const group of EIGHT) expected[group] = 'proficient';
  assert.deepEqual(g.groups, expected);
  // No weapon items for fighter; only armor and shields are enumerated.
  assert.equal(itemIds(g, 'weapon').length, 0);
});

test('classGrants: a category-choice class never silently fills a partial seed', () => {
  // Without seed, a partial selection is allowed.
  const partial = grants('fighter', ['Axes', 'Bows']);
  assert.deepEqual(Object.keys(partial.groups).sort(), ['Axes', 'Bows']);
  // With seed, fewer than 8 throws.
  assert.throws(
    () => grants('fighter', ['Axes', 'Bows'], { seed: true }),
    /exactly 8/
  );
  // With seed and exactly 8, it succeeds.
  assert.deepEqual(
    grants('fighter', EIGHT, { seed: true }).groups,
    Object.fromEntries(EIGHT.map((group) => [group, 'proficient']))
  );
});

test('classGrants: rejects more than 8 categories', () => {
  assert.throws(
    () => grants('fighter', [...EIGHT, 'Ambush Weapons']),
    /Too many categories/
  );
});

test('classGrants: rejects duplicate categories', () => {
  assert.throws(
    () => grants('fighter', ['Axes', 'Axes', 'Bows', 'Combat Blades', 'Dueling Blades', 'Flails', 'Hammers Picks', 'Spears']),
    /Duplicate category/
  );
});

test('classGrants: rejects unknown and forbidden categories', () => {
  assert.throws(() => grants('fighter', ['Axes', 'Bows', 'Swords', 'Combat Blades', 'Dueling Blades', 'Flails', 'Hammers Picks', 'Spears']), /Unknown or forbidden/);
  // Firearms is forbidden for barbarian.
  assert.throws(() => grants('barbarian', ['Firearms', 'Axes', 'Bows', 'Combat Blades', 'Dueling Blades', 'Flails', 'Hammers Picks', 'Spears']), /Unknown or forbidden/);
  // Crossbows is forbidden for barbarian.
  assert.throws(() => grants('barbarian', ['Crossbows', 'Axes', 'Bows', 'Combat Blades', 'Dueling Blades', 'Flails', 'Hammers Picks', 'Spears']), /Unknown or forbidden/);
  // Throwing Weapons is forbidden for paladin.
  assert.throws(() => grants('paladin', ['Throwing Weapons', 'Axes', 'Bows', 'Combat Blades', 'Crossbows', 'Dueling Blades', 'Flails', 'Hammers Picks']), /Unknown or forbidden/);
  // Polearms and Flails are forbidden for ranger.
  assert.throws(() => grants('ranger', ['Polearms', 'Axes', 'Bows', 'Combat Blades', 'Crossbows', 'Dueling Blades', 'Hammers Picks', 'Spears']), /Unknown or forbidden/);
  assert.throws(() => grants('ranger', ['Flails', 'Axes', 'Bows', 'Combat Blades', 'Crossbows', 'Dueling Blades', 'Hammers Picks', 'Spears']), /Unknown or forbidden/);
});

test('classGrants: barbarian excludes Clockwork weapons within a chosen category', () => {
  const groups = ['Ambush Weapons', 'Axes', 'Bows', 'Combat Blades', 'Dueling Blades', 'Flails', 'Hammers Picks', 'Spears'];
  const g = grants('barbarian', groups);
  // No group grants: barbarian enumerates per item because Clockwork applies.
  assert.deepEqual(g.groups, {});
  // Bows: collapsible-bow and compound-bow are Clockwork and must be cut.
  assert.ok(hasItem(g, 'bows/shortbow'));
  assert.ok(!hasItem(g, 'bows/collapsible-bow'));
  assert.ok(!hasItem(g, 'bows/compound-bow'));
  // Flails: claw-flail and spring-mace are Clockwork and must be cut.
  assert.ok(hasItem(g, 'flails/nunchaku'));
  assert.ok(!hasItem(g, 'flails/claw-flail'));
  assert.ok(!hasItem(g, 'flails/spring-mace'));
});

test('classGrants: paladin excludes Conceal weapons within a chosen category', () => {
  const groups = ['Ambush Weapons', 'Axes', 'Bows', 'Combat Blades', 'Crossbows', 'Dueling Blades', 'Flails', 'Hammers Picks'];
  const g = grants('paladin', groups);
  assert.deepEqual(g.groups, {});
  // Ambush Weapons: Conceal weapons are cut (cane-sword, interceptor, katar,
  // punch-dagger, war-fan, hidden-blade), non-Conceal stay.
  assert.ok(hasItem(g, 'ambush-weapons/compass-blade'));
  assert.ok(hasItem(g, 'ambush-weapons/gauntlet'));
  assert.ok(!hasItem(g, 'ambush-weapons/cane-sword'));
  assert.ok(!hasItem(g, 'ambush-weapons/interceptor'));
  assert.ok(!hasItem(g, 'ambush-weapons/hidden-blade'));
  // Crossbows: hidden-crossbow is Conceal; other crossbows stay.
  assert.ok(hasItem(g, 'crossbows/light-crossbow'));
  assert.ok(!hasItem(g, 'crossbows/hidden-crossbow'));
});

test('classGrants: ranger excludes Clockwork weapons within a chosen category', () => {
  const groups = ['Ambush Weapons', 'Axes', 'Bows', 'Combat Blades', 'Crossbows', 'Dueling Blades', 'Hammers Picks', 'Spears'];
  const g = grants('ranger', groups);
  assert.deepEqual(g.groups, {});
  // Bows: Clockwork cut.
  assert.ok(hasItem(g, 'bows/recurve'));
  assert.ok(!hasItem(g, 'bows/collapsible-bow'));
  assert.ok(!hasItem(g, 'bows/compound-bow'));
  // Crossbows: Clockwork cut (grapple, hidden-crossbow, spinner).
  assert.ok(hasItem(g, 'crossbows/light-crossbow'));
  assert.ok(!hasItem(g, 'crossbows/grapple-crossbow'));
  // Ranger does not exclude Conceal, so a Conceal Ambush weapon is granted.
  assert.ok(hasItem(g, 'ambush-weapons/cane-sword'));
});

test('classGrants: category-choice classes still get their armor and shields', () => {
  const g = grants('barbarian', EIGHT);
  assert.equal(itemIds(g, 'armor').length, 8);
  assert.equal(itemIds(g, 'shield').length, 7);
  assert.ok(!hasItem(g, 'shields/diskarmor'));
});

test('classGrants: an unknown class throws', () => {
  assert.throws(() => grants('bardz'), /Unknown class/);
});

test('classGrants: does not mutate its inputs', () => {
  const chosen = Object.freeze([...EIGHT]);
  const grantsBefore = classGrants('fighter', equipment, chosen);
  const deep = JSON.parse(JSON.stringify(grantsBefore));
  classGrants('fighter', equipment, chosen, { seed: true });
  assert.deepEqual(grants('fighter', chosen), deep);
});

// ---------------------------------------------------------------------------
// Armor and shields by class
// ---------------------------------------------------------------------------

test('classGrants: fighter gets every armor and every shield', () => {
  const g = grants('fighter', EIGHT);
  assert.equal(itemIds(g, 'armor').length, 12);
  assert.equal(itemIds(g, 'shield').length, 8);
  assert.ok(hasItem(g, 'armor/plate'));
  assert.ok(hasItem(g, 'shields/diskarmor'));
});

test('classGrants: paladin gets every armor and every shield', () => {
  const g = grants('paladin', ['Ambush Weapons', 'Axes', 'Bows', 'Combat Blades', 'Crossbows', 'Dueling Blades', 'Flails', 'Hammers Picks']);
  assert.equal(itemIds(g, 'armor').length, 12);
  assert.equal(itemIds(g, 'shield').length, 8);
});

test('classGrants: barbarian, cleric and ranger get medium+light armor and shields without Clockwork', () => {
  // Each class needs a category set that respects its own forbidden groups.
  const sets = {
    barbarian: EIGHT,
    cleric: EIGHT, // ignored: cleric has fixed grants
    ranger: RANGER_EIGHT,
  };
  for (const id of Object.keys(sets)) {
    const g = grants(id, sets[id]);
    assert.equal(itemIds(g, 'armor').length, 8, `${id}: armor count`);
    assert.equal(itemIds(g, 'shield').length, 7, `${id}: shield count`);
    assert.ok(!hasItem(g, 'shields/diskarmor'), `${id}: no Clockwork shield`);
    assert.ok(!hasItem(g, 'armor/hauberk'), `${id}: no heavy armor`);
  }
});

test('classGrants: artificer and druid get medium+light armor and all shields', () => {
  for (const id of ['artificer', 'druid']) {
    const g = grants(id);
    assert.equal(itemIds(g, 'armor').length, 8, `${id}: armor count`);
    assert.equal(itemIds(g, 'shield').length, 8, `${id}: shield count`);
    assert.ok(hasItem(g, 'shields/diskarmor'), `${id}: Clockwork shield allowed`);
    assert.ok(!hasItem(g, 'armor/plate'), `${id}: no heavy armor`);
  }
});

test('classGrants: bard, rogue and warlock get light armor only', () => {
  for (const id of ['bard', 'rogue', 'warlock']) {
    const g = grants(id);
    assert.equal(itemIds(g, 'armor').length, 4, `${id}: light armor count`);
    assert.equal(itemIds(g, 'shield').length, 0, `${id}: no shields`);
    const names = itemIds(g, 'armor').map((i) => byId.get(i).name);
    assert.deepEqual(names.sort(), ['Lacquered', 'Leather', 'Padded', 'Studded']);
    assert.ok(!hasItem(g, 'armor/chain-shirt'), `${id}: no medium armor`);
  }
});

test('classGrants: monk, sorcerer and wizard get no armor or shields', () => {
  for (const id of ['monk', 'sorcerer', 'wizard']) {
    const g = grants(id);
    assert.equal(itemIds(g, 'armor').length, 0, `${id}: armor`);
    assert.equal(itemIds(g, 'shield').length, 0, `${id}: shields`);
  }
});

// ---------------------------------------------------------------------------
// Multiclass basic training (rules/ClassTraining.md "Multiclass Basic Training")
// ---------------------------------------------------------------------------

test('multiclassGrants: all 13 classes produce their multiclass grants', () => {
  // Artificer: light+medium armor, all shields, no weapons.
  {
    const g = mg('artificer');
    assert.deepEqual(g.groups, {});
    assert.equal(itemIds(g, 'weapon').length, 0);
    assert.equal(itemIds(g, 'armor').length, 8);
    assert.equal(itemIds(g, 'shield').length, 8);
    assert.ok(hasItem(g, 'shields/diskarmor'));
    assert.ok(!hasItem(g, 'armor/plate'));
  }
  // Barbarian: shields + all simple weapons, no armor.
  {
    const g = mg('barbarian');
    assert.deepEqual(g.groups, {});
    assert.equal(itemIds(g, 'weapon').length, 52);
    assert.equal(itemIds(g, 'armor').length, 0);
    assert.equal(itemIds(g, 'shield').length, 8);
  }
  // Bard: light armor only.
  {
    const g = mg('bard');
    assert.deepEqual(g.groups, {});
    assert.equal(itemIds(g, 'weapon').length, 0);
    assert.equal(itemIds(g, 'armor').length, 4);
    assert.equal(itemIds(g, 'shield').length, 0);
  }
  // Cleric: light+medium armor, all shields, no weapons.
  {
    const g = mg('cleric');
    assert.deepEqual(g.groups, {});
    assert.equal(itemIds(g, 'weapon').length, 0);
    assert.equal(itemIds(g, 'armor').length, 8);
    assert.equal(itemIds(g, 'shield').length, 8);
  }
  // Druid: light+medium armor, all shields, no weapons.
  {
    const g = mg('druid');
    assert.deepEqual(g.groups, {});
    assert.equal(itemIds(g, 'weapon').length, 0);
    assert.equal(itemIds(g, 'armor').length, 8);
    assert.equal(itemIds(g, 'shield').length, 8);
  }
  // Monk: simple weapons + shortsword, no armor or shields.
  {
    const g = mg('monk');
    assert.deepEqual(g.groups, {});
    assert.equal(itemIds(g, 'weapon').length, 52);
    assert.ok(hasItem(g, 'dueling-blades/shortsword'));
    assert.equal(itemIds(g, 'armor').length, 0);
    assert.equal(itemIds(g, 'shield').length, 0);
  }
  // Rogue: light armor only.
  {
    const g = mg('rogue');
    assert.deepEqual(g.groups, {});
    assert.equal(itemIds(g, 'weapon').length, 0);
    assert.equal(itemIds(g, 'armor').length, 4);
    assert.equal(itemIds(g, 'shield').length, 0);
  }
  // Sorcerer: nothing.
  {
    const g = mg('sorcerer');
    assert.deepEqual(g, { groups: {}, items: {} });
  }
  // Warlock: light armor + simple weapons, no shields.
  {
    const g = mg('warlock');
    assert.deepEqual(g.groups, {});
    assert.equal(itemIds(g, 'weapon').length, 52);
    assert.equal(itemIds(g, 'armor').length, 4);
    assert.equal(itemIds(g, 'shield').length, 0);
  }
  // Wizard: nothing.
  {
    const g = mg('wizard');
    assert.deepEqual(g, { groups: {}, items: {} });
  }
});

const M_FOUR = ['Axes', 'Bows', 'Combat Blades', 'Dueling Blades'];

test('multiclassGrants: fighter grants the 4 chosen categories as group grants and no heavy armor', () => {
  const g = mg('fighter', M_FOUR);
  assert.deepEqual(g.groups, {
    Axes: 'proficient',
    Bows: 'proficient',
    'Combat Blades': 'proficient',
    'Dueling Blades': 'proficient',
  });
  // Fighter multiclass takes light+medium armor only, never heavy.
  assert.equal(itemIds(g, 'armor').length, 8);
  assert.ok(!hasItem(g, 'armor/plate'));
  assert.ok(!hasItem(g, 'armor/hauberk'));
  // Chosen categories are group grants, so no martial items are enumerated.
  assert.equal(itemIds(g, 'weapon').length, 52);
});

test('multiclassGrants: paladin forbids Firearms/Throwing/Whips and grants no heavy armor', () => {
  const g = mg('paladin', M_FOUR);
  assert.deepEqual(g.groups, {
    Axes: 'proficient',
    Bows: 'proficient',
    'Combat Blades': 'proficient',
    'Dueling Blades': 'proficient',
  });
  assert.equal(itemIds(g, 'armor').length, 8);
  assert.ok(!hasItem(g, 'armor/plate'));
  // Whips is forbidden for paladin multiclass (unlike the single-class grants).
  assert.throws(() => mg('paladin', ['Whips', 'Axes', 'Bows', 'Combat Blades']), /Unknown or forbidden/);
  assert.throws(() => mg('paladin', ['Firearms', 'Axes', 'Bows', 'Combat Blades']), /Unknown or forbidden/);
  assert.throws(() => mg('paladin', ['Throwing Weapons', 'Axes', 'Bows', 'Combat Blades']), /Unknown or forbidden/);
});

test('multiclassGrants: barbarian excludes Clockwork weapons per-item within a chosen category', () => {
  const g = mg('barbarian', ['Ambush Weapons', 'Axes', 'Bows', 'Combat Blades']);
  // Per-item enumeration: no group grants, Clockwork items are cut.
  assert.deepEqual(g.groups, {});
  assert.ok(hasItem(g, 'bows/shortbow'));
  assert.ok(!hasItem(g, 'bows/collapsible-bow'));
  assert.ok(!hasItem(g, 'bows/compound-bow'));
  assert.ok(hasItem(g, 'axes/battle-axe'));
});

test('multiclassGrants: ranger excludes Clockwork per-item and forbids Polearms/Flails', () => {
  const g = mg('ranger', ['Ambush Weapons', 'Axes', 'Bows', 'Crossbows']);
  assert.deepEqual(g.groups, {});
  assert.ok(hasItem(g, 'bows/recurve'));
  assert.ok(!hasItem(g, 'bows/collapsible-bow'));
  assert.ok(!hasItem(g, 'bows/compound-bow'));
  assert.ok(hasItem(g, 'crossbows/light-crossbow'));
  assert.ok(!hasItem(g, 'crossbows/grapple-crossbow'));
  assert.equal(itemIds(g, 'armor').length, 8);
  assert.ok(!hasItem(g, 'armor/plate'));
  assert.throws(() => mg('ranger', ['Polearms', 'Axes', 'Bows', 'Combat Blades']), /Unknown or forbidden/);
  assert.throws(() => mg('ranger', ['Flails', 'Axes', 'Bows', 'Combat Blades']), /Unknown or forbidden/);
});

test('multiclassGrants: category-choice classes require exactly 4 chosen categories when provided', () => {
  for (const id of ['barbarian', 'fighter', 'paladin', 'ranger']) {
    assert.throws(() => mg(id, ['Axes', 'Bows']), /exactly 4/);
    assert.throws(() => mg(id, ['Axes', 'Bows', 'Combat Blades', 'Dueling Blades', 'Flails']), /exactly 4/);
  }
  const g = mg('fighter', M_FOUR);
  assert.deepEqual(Object.keys(g.groups).sort(), [...M_FOUR].sort());
});

test('multiclassGrants: rejects duplicate and unknown or forbidden multiclass categories', () => {
  assert.throws(() => mg('fighter', ['Axes', 'Axes', 'Bows', 'Combat Blades']), /Duplicate category/);
  assert.throws(() => mg('fighter', ['Axes', 'Bows', 'Swords', 'Dueling Blades']), /Unknown or forbidden/);
  // Barbarian forbids Firearms and Crossbows.
  assert.throws(() => mg('barbarian', ['Firearms', 'Axes', 'Bows', 'Combat Blades']), /Unknown or forbidden/);
  assert.throws(() => mg('barbarian', ['Crossbows', 'Axes', 'Bows', 'Combat Blades']), /Unknown or forbidden/);
  // Paladin forbids Whips.
  assert.throws(() => mg('paladin', ['Whips', 'Axes', 'Bows', 'Combat Blades']), /Unknown or forbidden/);
  // Ranger forbids Polearms and Flails.
  assert.throws(() => mg('ranger', ['Polearms', 'Axes', 'Bows', 'Combat Blades']), /Unknown or forbidden/);
  assert.throws(() => mg('ranger', ['Flails', 'Axes', 'Bows', 'Combat Blades']), /Unknown or forbidden/);
});

test('multiclassGrants: an empty group choice returns the fixed grants for category classes', () => {
  const g = mg('fighter', []);
  assert.deepEqual(g.groups, {});
  // The fixed multiclass grants (simple weapons, armor, shields) are still present.
  assert.equal(itemIds(g, 'weapon').length, 52);
  assert.equal(itemIds(g, 'armor').length, 8);
  assert.equal(itemIds(g, 'shield').length, 8);
});

test('multiclassGrants: an unknown class throws', () => {
  assert.throws(() => mg('bardz'), /Unknown class/);
});

test('multiclassGrants: does not mutate its inputs', () => {
  const chosen = Object.freeze([...M_FOUR]);
  const before = mg('fighter', chosen);
  const deep = JSON.parse(JSON.stringify(before));
  mg('fighter', chosen);
  assert.deepEqual(mg('fighter', chosen), deep);
});
