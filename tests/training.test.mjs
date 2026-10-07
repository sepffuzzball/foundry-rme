import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  LEVELS,
  resolveTraining,
  grantTraining,
  selectTier,
} from '../src/training.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const catalog = JSON.parse(
  readFileSync(join(__dirname, '..', 'data', 'catalog.json'), 'utf8')
);

function entry(id) {
  const e = catalog.equipment.find((x) => x.id === id);
  assert.ok(e, `missing catalog entry ${id}`);
  return e;
}

// Reference entries used across the suite.
const battleAxe = entry('axes/battle-axe'); // weapon, group Axes (Basic labels)
const whip = entry('whips/whip'); // weapon, group Whips (Proficient labels)
const whipSword = entry('whips/whip-sword'); // two forms => 6 tier rows
const claw = entry('natural-weapons/claw'); // natural, default proficient
const unarmedStrike = entry('natural-weapons/unarmed-strike');
const bite = entry('natural-weapons/bite');
const chainShirt = entry('armor/chain-shirt'); // armor, no tiers
const buckler = entry('shields/buckler'); // shield, Basic/Expert rows only
const lightCrossbow = entry('crossbows/light-crossbow'); // expert row is lowercase "expert" in source

// ---------------------------------------------------------------------------
// LEVELS
// ---------------------------------------------------------------------------

test('LEVELS exposes the three training levels in order', () => {
  assert.deepEqual(LEVELS, ['untrained', 'proficient', 'expert']);
});

test('every exported function is present', () => {
  assert.equal(typeof resolveTraining, 'function');
  assert.equal(typeof grantTraining, 'function');
  assert.equal(typeof selectTier, 'function');
});

// ---------------------------------------------------------------------------
// resolveTraining - precedence
// ---------------------------------------------------------------------------

test('resolveTraining: explicit item override wins even when untrained', () => {
  const training = {
    groups: { Axes: 'expert' },
    items: { 'axes/battle-axe': 'untrained' },
  };
  assert.equal(resolveTraining(battleAxe, training), 'untrained');
});

test('resolveTraining: explicit item override wins over a lower-level group', () => {
  const training = {
    groups: { Axes: 'proficient' },
    items: { 'axes/battle-axe': 'expert' },
  };
  assert.equal(resolveTraining(battleAxe, training), 'expert');
});

test('resolveTraining: group fallback applies when there is no item override', () => {
  assert.equal(
    resolveTraining(battleAxe, { groups: { Axes: 'proficient' } }),
    'proficient'
  );
  assert.equal(
    resolveTraining(battleAxe, { groups: { Axes: 'expert' } }),
    'expert'
  );
});

test('resolveTraining: items/groups keys must be exact catalog values', () => {
  // A wrong group key (lowercase) must not match the catalog group 'Axes'.
  assert.equal(
    resolveTraining(battleAxe, { groups: { axes: 'proficient' } }),
    'untrained'
  );
});

test('resolveTraining: natural weapons default to proficient except unarmed strike', () => {
  assert.equal(resolveTraining(claw, {}), 'proficient');
  assert.equal(resolveTraining(bite, {}), 'proficient');
  assert.equal(resolveTraining(unarmedStrike, {}), 'untrained');
});

test('resolveTraining: non-natural, non-trained equipment defaults to untrained', () => {
  assert.equal(resolveTraining(battleAxe, {}), 'untrained');
  assert.equal(resolveTraining(whipSword, {}), 'untrained');
  assert.equal(resolveTraining(chainShirt, {}), 'untrained');
  assert.equal(resolveTraining(buckler, {}), 'untrained');
});

test('resolveTraining: natural default is only used for natural kind', () => {
  // An Armor entry shares no natural default.
  assert.equal(resolveTraining(chainShirt, {}), 'untrained');
});

// ---------------------------------------------------------------------------
// resolveTraining - no mutation
// ---------------------------------------------------------------------------

test('resolveTraining does not mutate its inputs', () => {
  const training = Object.freeze({
    groups: Object.freeze({ Axes: 'proficient' }),
    items: Object.freeze({ 'axes/battle-axe': 'expert' }),
  });
  const equipment = Object.freeze({ ...battleAxe });
  resolveTraining(equipment, training);
  assert.equal(training.groups.Axes, 'proficient');
  assert.equal(training.items['axes/battle-axe'], 'expert');
});

// ---------------------------------------------------------------------------
// grantTraining - duplicate item grants, non-multiclass vs multiclass
// ---------------------------------------------------------------------------

test('grantTraining: duplicate item proficient grants promote to expert only when not multiclass', () => {
  const sourceA = grantTraining({}, { items: { 'axes/battle-axe': 'proficient' } });
  assert.equal(sourceA.items['axes/battle-axe'], 'proficient');

  const promoted = grantTraining(sourceA, {
    items: { 'axes/battle-axe': 'proficient' },
  });
  assert.equal(promoted.items['axes/battle-axe'], 'expert');

  const multiclass = grantTraining(
    sourceA,
    { items: { 'axes/battle-axe': 'proficient' } },
    { multiclass: true }
  );
  assert.equal(multiclass.items['axes/battle-axe'], 'proficient');
});

test('grantTraining: duplicate item grants promoted only once and clamped at expert', () => {
  const sourceA = grantTraining({}, { items: { 'axes/battle-axe': 'proficient' } });
  const promoted = grantTraining(sourceA, {
    items: { 'axes/battle-axe': 'proficient' },
  });
  assert.equal(promoted.items['axes/battle-axe'], 'expert');

  const again = grantTraining(promoted, {
    items: { 'axes/battle-axe': 'proficient' },
  });
  assert.equal(again.items['axes/battle-axe'], 'expert');
});

test('grantTraining: an already expert item granted proficient stays expert', () => {
  const training = { items: { 'axes/battle-axe': 'expert' } };
  const result = grantTraining(training, {
    items: { 'axes/battle-axe': 'proficient' },
  });
  assert.equal(result.items['axes/battle-axe'], 'expert');
});

test('grantTraining: explicit expert grant sets expert and cannot be exceeded', () => {
  const result = grantTraining({}, {
    items: { 'axes/battle-axe': 'expert' },
  });
  assert.equal(result.items['axes/battle-axe'], 'expert');
});

// ---------------------------------------------------------------------------
// grantTraining - group-level grants do not auto-promote
// ---------------------------------------------------------------------------

test('grantTraining: duplicate group-level proficient grants do not promote to expert', () => {
  const sourceA = grantTraining({}, { groups: { Axes: 'proficient' } });
  const second = grantTraining(sourceA, { groups: { Axes: 'proficient' } });
  assert.equal(second.groups.Axes, 'proficient');
});

test('grantTraining: explicit group expert grant sets and keeps expert', () => {
  const expert = grantTraining({}, { groups: { Axes: 'expert' } });
  assert.equal(expert.groups.Axes, 'expert');

  const clamped = grantTraining(expert, { groups: { Axes: 'proficient' } });
  assert.equal(clamped.groups.Axes, 'expert');
});

// ---------------------------------------------------------------------------
// grantTraining - explicit overrides preserved
// ---------------------------------------------------------------------------

test('grantTraining: group grant does not clobber an explicit item override', () => {
  const training = { items: { 'axes/battle-axe': 'untrained' } };
  const result = grantTraining(training, { groups: { Axes: 'proficient' } });
  assert.equal(result.items['axes/battle-axe'], 'untrained');
  assert.equal(result.groups.Axes, 'proficient');
});

test('grantTraining: an explicit item override that is not granted is preserved', () => {
  const training = { items: { 'whips/whip': 'expert' } };
  const result = grantTraining(training, { groups: { Whips: 'proficient' } });
  assert.equal(result.items['whips/whip'], 'expert');
});

test('grantTraining: a direct item grant overrides an explicit untrained override', () => {
  const training = { items: { 'axes/battle-axe': 'untrained' } };
  const result = grantTraining(training, {
    items: { 'axes/battle-axe': 'proficient' },
  });
  assert.equal(result.items['axes/battle-axe'], 'proficient');
});

// ---------------------------------------------------------------------------
// grantTraining - immutability
// ---------------------------------------------------------------------------

test('grantTraining returns a new object and does not mutate training or grants', () => {
  const training = Object.freeze({
    groups: Object.freeze({ Axes: 'expert' }),
    items: Object.freeze({ 'axes/battle-axe': 'untrained' }),
  });
  const grants = Object.freeze({
    groups: Object.freeze({ Whips: 'proficient' }),
    items: Object.freeze({ 'whips/whip': 'proficient' }),
  });

  const result = grantTraining(training, grants);

  assert.notEqual(result, training);
  assert.notEqual(result, grants);
  assert.equal(training.groups.Axes, 'expert');
  assert.equal(training.items['axes/battle-axe'], 'untrained');
  assert.equal(grants.groups.Whips, 'proficient');
  assert.equal(grants.items['whips/whip'], 'proficient');
});

test('grantTraining result is a fresh, mutable-enough object that does not alias inputs', () => {
  const training = { groups: { Axes: 'proficient' } };
  const result = grantTraining(training, { groups: { Axes: 'proficient' } });
  assert.notEqual(result, training);
  assert.notEqual(result.groups, training.groups);
});

// ---------------------------------------------------------------------------
// selectTier - tier labels (Basic and Proficient equivalent)
// ---------------------------------------------------------------------------

test('selectTier: Basic and Proficient labels are equivalent at proficient level', () => {
  // battle-axe publishes a Basic row; whip publishes a Proficient row. Both
  // must be selected at the proficient level.
  const axe = selectTier(battleAxe, { groups: { Axes: 'proficient' } });
  assert.equal(axe.level, 'proficient');
  assert.equal(axe.rawRows.length, 1);
  assert.match(axe.rawRows[0], /^Basic /);

  const whipResult = selectTier(whip, { groups: { Whips: 'proficient' } });
  assert.equal(whipResult.level, 'proficient');
  assert.equal(whipResult.rawRows.length, 1);
  assert.match(whipResult.rawRows[0], /^Proficient /);
});

test('selectTier: untrained level selects only Untrained rows', () => {
  const result = selectTier(battleAxe, {});
  assert.equal(result.level, 'untrained');
  assert.equal(result.rawRows.length, 1);
  assert.match(result.rawRows[0], /^Untrained /);
});

test('selectTier: expert level selects only Expert rows', () => {
  const result = selectTier(battleAxe, { groups: { Axes: 'expert' } });
  assert.equal(result.level, 'expert');
  assert.equal(result.rawRows.length, 1);
  assert.match(result.rawRows[0], /^Expert /);
});

test('selectTier: light crossbow expert row (lowercase in source) is selected at expert', () => {
  // The source writes the Light Crossbow's expert row as lowercase "expert";
  // it must still be normalized and selected at the expert level.
  const result = selectTier(lightCrossbow, { groups: { Crossbows: 'expert' } });
  assert.equal(result.level, 'expert');
  assert.equal(result.rawRows.length, 1);
  assert.match(result.rawRows[0], /^Expert .*d8\+3 \(160\/320\)/);

  // Proficient must not accidentally select the expert row.
  const proficient = selectTier(lightCrossbow, {
    groups: { Crossbows: 'proficient' },
  });
  assert.equal(proficient.rawRows.length, 1);
  assert.match(proficient.rawRows[0], /^Basic /);
  assert.doesNotMatch(proficient.rawRows[0], /\(160\/320\)/);
});

// ---------------------------------------------------------------------------
// selectTier - Whip Sword multiple form rows
// ---------------------------------------------------------------------------

test('selectTier: Whip Sword returns one row per form at each level', () => {
  // The Whip Sword has two forms and therefore two tier rows per level.
  const expert = selectTier(whipSword, { items: { 'whips/whip-sword': 'expert' } });
  assert.equal(expert.level, 'expert');
  assert.equal(expert.rawRows.length, 2);
  assert.ok(expert.rawRows.every((row) => /^Expert /.test(row)));

  const proficient = selectTier(whipSword, {
    items: { 'whips/whip-sword': 'proficient' },
  });
  assert.equal(proficient.level, 'proficient');
  assert.equal(proficient.rawRows.length, 2);
  assert.ok(proficient.rawRows.every((row) => /^(Basic|Proficient) /.test(row)));

  const untrained = selectTier(whipSword, {
    items: { 'whips/whip-sword': 'untrained' },
  });
  assert.equal(untrained.level, 'untrained');
  assert.equal(untrained.rawRows.length, 2);
  assert.ok(untrained.rawRows.every((row) => /^Untrained /.test(row)));
});

// ---------------------------------------------------------------------------
// selectTier - expert perk only at expert
// ---------------------------------------------------------------------------

test('selectTier: expert perk is available only at expert level', () => {
  const expert = selectTier(whipSword, { items: { 'whips/whip-sword': 'expert' } });
  assert.equal(typeof expert.expertPerk, 'string');
  assert.ok(expert.expertPerk.length > 0);

  const proficient = selectTier(whipSword, {
    items: { 'whips/whip-sword': 'proficient' },
  });
  assert.equal(proficient.expertPerk, null);

  const untrained = selectTier(whipSword, {});
  assert.equal(untrained.expertPerk, null);
});

// ---------------------------------------------------------------------------
// selectTier - armor and shield absent tier returns []
// ---------------------------------------------------------------------------

test('selectTier: armor has no tiers so rawRows is always empty', () => {
  const result = selectTier(chainShirt, { groups: { Armor: 'proficient' } });
  assert.equal(result.level, 'proficient');
  assert.deepEqual(result.rawRows, []);
  assert.equal(result.expertPerk, null);
});

test('selectTier: shield returns Basic row at proficient and [] when the tier is absent', () => {
  // The buckler publishes only Basic and Expert rows; it has no Untrained row.
  const proficient = selectTier(buckler, { groups: { Shields: 'proficient' } });
  assert.equal(proficient.level, 'proficient');
  assert.equal(proficient.rawRows.length, 1);
  assert.match(proficient.rawRows[0], /^Basic /);

  const untrained = selectTier(buckler, { items: { 'shields/buckler': 'untrained' } });
  assert.equal(untrained.level, 'untrained');
  assert.deepEqual(untrained.rawRows, []);

  const expert = selectTier(buckler, { groups: { Shields: 'expert' } });
  assert.equal(expert.level, 'expert');
  assert.equal(expert.rawRows.length, 1);
  assert.match(expert.rawRows[0], /^Expert /);
});

// ---------------------------------------------------------------------------
// selectTier - group fallback does not confer expert on unrelated items
// ---------------------------------------------------------------------------

test('selectTier: group fallback does not confer expert on an unrelated item', () => {
  // whip-sword was promoted to expert via duplicated item grants, but the
  // Whips group is only proficient. The unrelated whip must remain proficient,
  // not inherit whip-sword's expert level.
  const training = {
    groups: { Whips: 'proficient' },
    items: { 'whips/whip-sword': 'expert' },
  };

  const sword = selectTier(whipSword, training);
  assert.equal(sword.level, 'expert');
  assert.equal(sword.rawRows.length, 2);

  const plainWhip = selectTier(whip, training);
  assert.equal(plainWhip.level, 'proficient');
  assert.equal(plainWhip.rawRows.length, 1);
  assert.match(plainWhip.rawRows[0], /^Proficient /);
});

// ---------------------------------------------------------------------------
// selectTier - no mutation
// ---------------------------------------------------------------------------

test('selectTier and resolveTraining do not mutate the training or equipment', () => {
  const training = Object.freeze({
    groups: Object.freeze({ Whips: 'proficient' }),
    items: Object.freeze({ 'whips/whip-sword': 'expert' }),
  });
  const equipment = Object.freeze({ ...whipSword, tiers: Object.freeze([...whipSword.tiers]) });

  selectTier(equipment, training);
  resolveTraining(equipment, training);

  assert.equal(training.groups.Whips, 'proficient');
  assert.equal(training.items['whips/whip-sword'], 'expert');
  assert.equal(equipment.tiers.length, 6);
});
