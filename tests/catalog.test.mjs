import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Load the generated catalog. It is the source of truth for these regression
// checks and must be regenerated via `npm run build:catalog`.
const catalog = JSON.parse(
  readFileSync(join(__dirname, '..', 'data', 'catalog.json'), 'utf8')
);

const equipment = catalog.equipment;
const references = catalog.references;

// ---------------------------------------------------------------------------
// Counts
// ---------------------------------------------------------------------------

test('catalog contains exactly 173 equipment entries', () => {
  assert.equal(equipment.length, 173);
});

test('catalog contains exactly 24 references', () => {
  assert.equal(references.length, 24);
});

test('catalog contains 145 standard weapons', () => {
  const weapons = equipment.filter((e) => e.kind === 'weapon');
  assert.equal(weapons.length, 145);
});

test('catalog contains 8 natural weapons', () => {
  const natural = equipment.filter((e) => e.kind === 'natural');
  assert.equal(natural.length, 8);
  assert.ok(natural.every((e) => e.source === 'rules/NaturalWeapons.md'));
});

test('catalog contains 8 shields', () => {
  const shields = equipment.filter((e) => e.kind === 'shield');
  assert.equal(shields.length, 8);
  assert.ok(shields.every((e) => e.source === 'rules/Shields.md'));
});

test('catalog contains 12 armor entries', () => {
  const armor = equipment.filter((e) => e.kind === 'armor');
  assert.equal(armor.length, 12);
  assert.ok(armor.every((e) => e.source === 'rules/Armor.md'));
});

// ---------------------------------------------------------------------------
// IDs
// ---------------------------------------------------------------------------

test('all equipment ids are unique', () => {
  const ids = equipment.map((e) => e.id);
  assert.equal(new Set(ids).size, ids.length);
});

test('equipment ids do not collide with reference ids', () => {
  const equipmentIds = new Set(equipment.map((e) => e.id));
  const referenceIds = new Set(references.map((r) => r.id));
  const collisions = [...equipmentIds].filter((id) => referenceIds.has(id));
  assert.deepEqual(collisions, []);
});

// ---------------------------------------------------------------------------
// Raw source block descriptions (armor excluded)
// ---------------------------------------------------------------------------

test('non-armor descriptions are verbatim source blocks', () => {
  const nonArmor = equipment.filter((e) => e.kind !== 'armor');
  for (const entry of nonArmor) {
    const source = readFileSync(
      join(__dirname, '..', entry.source),
      'utf8'
    );
    assert.ok(
      source.includes(entry.description),
      `${entry.id}: description is not a verbatim block from ${entry.source}`
    );
    assert.ok(
      entry.description.startsWith(`##### ${entry.name}`),
      `${entry.id}: description does not start with its name heading`
    );
  }
});

// ---------------------------------------------------------------------------
// Tier labels
// ---------------------------------------------------------------------------

const TIER_LABELS = new Set(['Untrained', 'Proficient', 'Basic', 'Expert']);

// Resolve the tier label of a training row. Source tier rows can be compressed
// with no space after the label (e.g. "UntrainedOne-Handed, ..."), so we match
// the leading label token instead of splitting on whitespace.
function resolveTierLabel(row) {
  const m = /^(Untrained|Proficient|Basic|Expert)/.exec(row);
  return m ? m[1] : null;
}

// Basic and Proficient name the same training tier in this rule set, and the
// source is inconsistent about which it uses, so they normalize to one value.
function canonicalTier(label) {
  return label === 'Proficient' ? 'Basic' : label;
}

test('every non-armor entry has at least one tier row', () => {
  for (const entry of equipment.filter((e) => e.kind !== 'armor')) {
    assert.ok(
      entry.tiers.length > 0,
      `${entry.id}: expected at least one tier row`
    );
  }
});

test('every armor entry has no tier rows', () => {
  for (const entry of equipment.filter((e) => e.kind === 'armor')) {
    assert.deepEqual(entry.tiers, [], `${entry.id}: armor must have no tiers`);
  }
});

test('every tier row resolves to a known label', () => {
  for (const entry of equipment) {
    for (const row of entry.tiers) {
      const label = resolveTierLabel(row);
      assert.ok(
        label !== null,
        `${entry.id}: unable to resolve tier label for "${row}"`
      );
      assert.ok(
        TIER_LABELS.has(label),
        `${entry.id}: unexpected tier label "${label}"`
      );
    }
  }
});

test('all tier labels normalize consistently (Basic/Proficient)', () => {
  const canonicalLabels = new Set();
  for (const entry of equipment) {
    for (const row of entry.tiers) {
      const label = resolveTierLabel(row);
      const canonical = canonicalTier(label);
      canonicalLabels.add(canonical);
      assert.ok(
        canonical === 'Untrained' ||
          canonical === 'Basic' ||
          canonical === 'Expert',
        `${entry.id}: tier label "${label}" does not normalize`
      );
    }
  }
  // Basic and Proficient must collapse to one canonical value (Basic here).
  assert.ok(!canonicalLabels.has('Proficient'));
});

test('light crossbow expert row is captured and normalized while the description stays verbatim', () => {
  const entry = equipment.find((e) => e.id === 'crossbows/light-crossbow');
  assert.ok(entry, 'light crossbow entry present');

  // The source writes this row lowercase ("expert ..."), but it must be parsed
  // as a tier row and normalized to the canonical Expert form in `tiers`.
  const rawExpertRow =
    'expert Two-Handed, Ranged d8+3 (160/320), Reload object interaction, Keen, Punch, Steady, Sighted';
  const expert = entry.tiers.find(
    (row) => /^Expert /.test(row) && /\(160\/320\)/.test(row)
  );
  assert.ok(
    expert,
    'light crossbow expert row is missing from the tiers array'
  );
  assert.equal(expert, rawExpertRow.replace(/^expert /, 'Expert '));

  // The complete description must preserve the original raw row verbatim,
  // including the source's lowercase "expert", without fabrication.
  assert.ok(
    entry.description.includes(rawExpertRow),
    'light crossbow description does not preserve the raw expert row'
  );
});

// ---------------------------------------------------------------------------
// Armor descriptions
// ---------------------------------------------------------------------------

test('armor descriptions preserve the table row and include the descriptive paragraph', () => {
  const armor = equipment.filter((e) => e.kind === 'armor');
  for (const entry of armor) {
    assert.ok(
      /^(.+?)\s+\d+\s+(None|Disadvantage|Normal)\s+\d+\s+\d+/m.test(
        entry.description
      ),
      `${entry.id}: armor description missing its table row`
    );
    assert.ok(
      entry.description.includes('\n\n**'),
      `${entry.id}: armor description missing its descriptive paragraph`
    );
  }
});
