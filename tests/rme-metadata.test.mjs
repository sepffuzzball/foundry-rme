import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  RME_PROPERTY_NAMES,
  RME_WEAPON_GROUPS,
  parsePhysical,
  physicalParseIssues,
  tierProperties,
  rmeWeaponType,
} from '../src/rme-metadata.mjs';

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

const boltActionRifle = entry('firearms/bolt-action-rifle');
const portableCatapult = entry('launch-weapons/portable-catapult');
const dart = entry('throwing-weapons/dart');
const throwingKnife = entry('throwing-weapons/throwing-knife');
const padded = entry('armor/padded');
const leather = entry('armor/leather');
const skirmish = entry('shields/skirmish');
const armGuard = entry('shields/arm-guard');
const claw = entry('natural-weapons/claw');
const tail = entry('natural-weapons/tail');
const chainShirt = entry('armor/chain-shirt');
const wingedSpear = entry('spears/winged-spear');
const guisarme = entry('polearms/guisarme');

// Property identity: the ` (#)` placeholder denotes a numeric parameter, not
// part of the name. tierProperties labels are these base names.
const KNOWN_PROPERTY_BASES = new Set(
  RME_PROPERTY_NAMES.map((n) => n.replace(/\s*\(#\)$/, '').toLowerCase())
);

// ---------------------------------------------------------------------------
// Property names
// ---------------------------------------------------------------------------

test('RME_PROPERTY_NAMES matches every ##### heading in WeaponProperties.md', () => {
  // Note: the spec text says "40 headings" but rules/WeaponProperties.md
  // currently lists 42. This test reflects the source as the source of truth.
  const source = readFileSync(
    join(__dirname, '..', 'rules', 'WeaponProperties.md'),
    'utf8'
  );
  const headings = [...source.matchAll(/^##### (.+)$/gm)].map((m) => m[1].trim());

  assert.ok(headings.length >= 40, 'source has at least 40 property headings');
  assert.deepEqual(RME_PROPERTY_NAMES, headings);
  assert.equal(new Set(RME_PROPERTY_NAMES).size, RME_PROPERTY_NAMES.length);
  for (const name of RME_PROPERTY_NAMES) {
    assert.ok(name.length > 0, 'property names are non-empty');
  }
});

test('RME_PROPERTY_NAMES contains the parameterized headings verbatim', () => {
  assert.ok(RME_PROPERTY_NAMES.includes('Firearm (#)'));
  assert.ok(RME_PROPERTY_NAMES.includes('Loading (#)'));
  assert.ok(RME_PROPERTY_NAMES.includes('Unwieldy (#)'));
});

test('every RME property base name is usable as a tier label', () => {
  // Firearm / Loading / Unwieldy appear in catalog tiers without the (#) marker.
  assert.ok(KNOWN_PROPERTY_BASES.has('firearm'));
  assert.ok(KNOWN_PROPERTY_BASES.has('loading'));
  assert.ok(KNOWN_PROPERTY_BASES.has('unwieldy'));
  assert.ok(KNOWN_PROPERTY_BASES.has('melee'));
  assert.ok(KNOWN_PROPERTY_BASES.has('ranged'));
});

// ---------------------------------------------------------------------------
// Weapon groups
// ---------------------------------------------------------------------------

test('RME_WEAPON_GROUPS is the 15 canonical weapon groups', () => {
  assert.deepEqual(RME_WEAPON_GROUPS, [
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
  ]);
  assert.equal(RME_WEAPON_GROUPS.length, 15);
  assert.ok(!RME_WEAPON_GROUPS.includes('Shields'));
  assert.ok(!RME_WEAPON_GROUPS.includes('Natural Weapons'));
  assert.ok(!RME_WEAPON_GROUPS.includes('Armor'));
});

test('rmeWeaponType returns a stable config key and melee/ranged mode', () => {
  assert.deepEqual(rmeWeaponType('Axes'), { key: 'rmeAxes', mode: 'melee' });
  assert.deepEqual(rmeWeaponType('Bludgeons'), {
    key: 'rmeBludgeons',
    mode: 'melee',
  });
  assert.deepEqual(rmeWeaponType('Hammers Picks'), {
    key: 'rmeHammersPicks',
    mode: 'melee',
  });
  assert.deepEqual(rmeWeaponType('Bows'), { key: 'rmeBows', mode: 'ranged' });
  assert.deepEqual(rmeWeaponType('Crossbows'), {
    key: 'rmeCrossbows',
    mode: 'ranged',
  });
  assert.deepEqual(rmeWeaponType('Firearms'), {
    key: 'rmeFirearms',
    mode: 'ranged',
  });
  assert.deepEqual(rmeWeaponType('Launch Weapons'), {
    key: 'rmeLaunchWeapons',
    mode: 'ranged',
  });
  assert.deepEqual(rmeWeaponType('Throwing Weapons'), {
    key: 'rmeThrowingWeapons',
    mode: 'ranged',
  });
});

test('rmeWeaponType keeps natural weapons native natural', () => {
  assert.deepEqual(rmeWeaponType('Natural Weapons'), {
    key: 'natural',
    mode: 'natural',
  });
});

test('rmeWeaponType returns each configured group key and mode', () => {
  const byMode = { melee: [], ranged: [] };
  for (const group of RME_WEAPON_GROUPS) {
    const result = rmeWeaponType(group);
    assert.ok(result, `${group}: expected a config`);
    assert.match(result.key, /^rme[A-Za-z]+$/, `${group}: stable key`);
    assert.ok(
      result.mode === 'melee' || result.mode === 'ranged',
      `${group}: mode hint`
    );
    byMode[result.mode].push(group);
  }
  assert.deepEqual(
    byMode.ranged.sort(),
    ['Bows', 'Crossbows', 'Firearms', 'Launch Weapons', 'Throwing Weapons']
  );
  assert.equal(byMode.ranged.length, 5);
  assert.equal(byMode.melee.length, 10);
});

test('rmeWeaponType returns null for unknown and non-weapon groups', () => {
  assert.equal(rmeWeaponType('Shields'), null);
  assert.equal(rmeWeaponType('Armor'), null);
  assert.equal(rmeWeaponType('Not A Group'), null);
  assert.equal(rmeWeaponType(''), null);
});

// ---------------------------------------------------------------------------
// parsePhysical
// ---------------------------------------------------------------------------

test('parsePhysical reads weapon weight and price', () => {
  assert.deepEqual(parsePhysical(boltActionRifle), {
    weight: { value: 12, units: 'lb' },
    price: { value: 1000, denomination: 'gp' },
  });
});

test('parsePhysical interprets the source 175g typo as gp', () => {
  // Source: "_Bludgeoning, 20lb, 175g_" (Portable Catapult). The trailing "g"
  // is a typo for "gp"; it is interpreted as gp with a source comment.
  assert.deepEqual(parsePhysical(portableCatapult), {
    weight: { value: 20, units: 'lb' },
    price: { value: 175, denomination: 'gp' },
  });
});

test('parsePhysical handles decimal weights and silver/copper denominations', () => {
  assert.deepEqual(parsePhysical(dart), {
    weight: { value: 0.05, units: 'lb' },
    price: { value: 1, denomination: 'sp' },
  });
  assert.deepEqual(parsePhysical(throwingKnife), {
    weight: { value: 0.5, units: 'lb' },
    price: { value: 25, denomination: 'cp' },
  });
});

test('parsePhysical matches a standalone weight without a cost', () => {
  const malformed = {
    id: 'test/weight-only',
    group: 'Test',
    name: 'Weight Only',
    kind: 'weapon',
    description:
      '##### Weight Only\n\n_Slashing, 4lb_\n\nUntrained One-Handed, Melee d6',
  };
  assert.deepEqual(parsePhysical(malformed), {
    weight: { value: 4, units: 'lb' },
  });
});

test('parsePhysical handles whitespace and case variants', () => {
  const entryLike = {
    id: 'test/case',
    group: 'Test',
    name: 'Case',
    kind: 'weapon',
    description:
      '##### Case\n\n_PIERcIng ,  1.5 LBS , 100 GP_\n\nUntrained One-Handed, Melee d6',
  };
  assert.deepEqual(parsePhysical(entryLike), {
    weight: { value: 1.5, units: 'lb' },
    price: { value: 100, denomination: 'gp' },
  });
});

test('parsePhysical reads the armor table row with all costs in gp', () => {
  assert.deepEqual(parsePhysical(padded), {
    weight: { value: 4, units: 'lb' },
    price: { value: 5, denomination: 'gp' },
  });
  assert.deepEqual(parsePhysical(leather), {
    weight: { value: 5, units: 'lb' },
    price: { value: 10, denomination: 'gp' },
  });
});

test('parsePhysical reads the shield stat line', () => {
  assert.deepEqual(parsePhysical(skirmish), {
    weight: { value: 6, units: 'lb' },
    price: { value: 10, denomination: 'gp' },
  });
});

test('parsePhysical omits weight and price for natural weapons', () => {
  assert.deepEqual(parsePhysical(claw), {});
  assert.deepEqual(parsePhysical(tail), {});
});

test('parsePhysical does not fabricate a 0 for a missing value', () => {
  const weightOnly = {
    id: 'test/weight-only',
    group: 'Test',
    name: 'Weight Only',
    kind: 'weapon',
    description:
      '##### Weight Only\n\n_Slashing, 4lb_\n\nUntrained One-Handed, Melee d6',
  };
  const parsed = parsePhysical(weightOnly);
  assert.deepEqual(parsed.weight, { value: 4, units: 'lb' });
  assert.equal(parsed.price, undefined);

  const priceOnly = {
    id: 'test/price-only',
    group: 'Test',
    name: 'Price Only',
    kind: 'weapon',
    description:
      '##### Price Only\n\n_Slashing, 25cp_\n\nUntrained One-Handed, Melee d6',
  };
  const parsedPriceOnly = parsePhysical(priceOnly);
  assert.equal(parsedPriceOnly.weight, undefined);
  assert.deepEqual(parsedPriceOnly.price, { value: 25, denomination: 'cp' });
});

// ---------------------------------------------------------------------------
// physicalParseIssues
// ---------------------------------------------------------------------------

test('physicalParseIssues reports no missing stats for the current catalog', () => {
  assert.deepEqual(physicalParseIssues(equipment), []);
});

test('physicalParseIssues excludes natural weapons and lists only non-natural gaps', () => {
  const gap = {
    id: 'test/gap',
    group: 'Test',
    name: 'Gap',
    kind: 'weapon',
    description: '##### Gap\n\n_Slashing, 4lb_\n\nUntrained One-Handed, Melee d6',
  };
  const natural = {
    id: 'test/natural',
    group: 'Test',
    name: 'Nat',
    kind: 'natural',
    description: '##### Nat\n\n_Piercing_\n\nProficient Finesse, Natural, Melee',
  };
  const issues = physicalParseIssues([gap, natural]);
  assert.equal(issues.length, 1);
  assert.equal(issues[0].id, 'test/gap');
  assert.deepEqual(issues[0].missing, ['price']);
});

// ---------------------------------------------------------------------------
// tierProperties
// ---------------------------------------------------------------------------

test('tierProperties: bolt rifle is Awkward only when untrained', () => {
  const untrained = tierProperties(boltActionRifle, 'untrained');
  const labels = (props) => props.map((p) => p.label);
  assert.ok(labels(untrained).includes('Awkward'));

  assert.ok(!labels(tierProperties(boltActionRifle, 'proficient')).includes('Awkward'));
  assert.ok(!labels(tierProperties(boltActionRifle, 'expert')).includes('Awkward'));
  // "basic" is an alias for the selected Basic/Proficient tier.
  assert.deepEqual(
    tierProperties(boltActionRifle, 'basic'),
    tierProperties(boltActionRifle, 'proficient')
  );
});

test('tierProperties: bolt rifle damage-range raw and parameter at Basic/Expert', () => {
  const basic = tierProperties(boltActionRifle, 'proficient');
  const basicRanged = basic.find((p) => p.label === 'Ranged');
  assert.ok(basicRanged, 'Basic row has a Ranged property');
  assert.equal(basicRanged.raw, 'Ranged 2d8 (200/800)');
  assert.equal(basicRanged.parameter, '200/800');

  const expert = tierProperties(boltActionRifle, 'expert');
  const expertRanged = expert.find((p) => p.label === 'Ranged');
  assert.ok(expertRanged, 'Expert row has a Ranged property');
  assert.equal(expertRanged.raw, 'Ranged 2d8 (250/1000)');
  assert.equal(expertRanged.parameter, '250/1000');

  const expertReload = expert.find((p) => p.label === 'Reload');
  assert.ok(expertReload, 'Expert row has a Reload property');
  assert.equal(expertReload.raw, 'Reload (Object Interaction (single cartridge))');
  assert.equal(expertReload.parameter, 'Object Interaction (single cartridge)');
});

test('tierProperties: tolerant of a missing comma between Double Ended (...) Knockback', () => {
  const proficient = tierProperties(tail, 'proficient');
  const labels = proficient.map((p) => p.label);
  assert.ok(labels.includes('Double Ended'));
  assert.ok(labels.includes('Knockback'));

  const doubleEnded = proficient.find((p) => p.label === 'Double Ended');
  assert.equal(doubleEnded.raw, 'Double Ended (one dice size smaller)');
  assert.equal(doubleEnded.parameter, 'one dice size smaller');
});

test('tierProperties: Melee and Ranged are recognized properties', () => {
  const shortbow = equipment.find((e) => e.id === 'bows/shortbow');
  const ranged = tierProperties(shortbow, 'proficient').find((p) => p.label === 'Ranged');
  assert.ok(ranged, 'shortbow has a Ranged property');
  assert.equal(ranged.raw, 'Ranged d6 (80/320)');
  assert.equal(ranged.parameter, '80/320');
});

test('tierProperties: source typos are normalized to known properties', () => {
  const wingedLabels = tierProperties(wingedSpear, 'proficient').map((p) => p.label);
  assert.ok(wingedLabels.includes('Puncture'), 'winged-spear Punc maps to Puncture');
  const guisarmeLabels = tierProperties(guisarme, 'expert').map((p) => p.label);
  assert.ok(guisarmeLabels.includes('Two-Handed'), 'guisarme "Two handed" maps to Two-Handed');
});

test('tierProperties: armor has no tiers so yields no properties', () => {
  assert.deepEqual(tierProperties(chainShirt, 'proficient'), []);
});

test('tierProperties: Skirmish shield prose does not grant Ranged', () => {
  // Basic/Expert prose mention "ranged weapon attacks" / "ranged spell attacks"
  // but the shield grants no Ranged property.
  assert.deepEqual(tierProperties(skirmish, 'untrained'), []);
  assert.deepEqual(tierProperties(skirmish, 'proficient'), []);
  assert.deepEqual(tierProperties(skirmish, 'expert'), []);
});

test('tierProperties: Arm Guard prose does not grant Light or Affixed', () => {
  // Basic prose says "attach a Light weapon" and "gains the Affixed property",
  // but neither is a property of the arm guard itself.
  assert.deepEqual(tierProperties(armGuard, 'untrained'), []);
  assert.deepEqual(tierProperties(armGuard, 'proficient'), []);
  assert.deepEqual(tierProperties(armGuard, 'expert'), []);
});

test('tierProperties: no shield or armor entry grants any property at any level', () => {
  const levels = ['untrained', 'proficient', 'expert'];
  for (const entry of equipment) {
    if (entry.kind !== 'shield' && entry.kind !== 'armor') continue;
    for (const level of levels) {
      assert.deepEqual(
        tierProperties(entry, level),
        [],
        `${entry.id}@${level}: shield/armor should grant no properties`
      );
    }
  }
});

test('tierProperties: Bolt-Action Rifle is unchanged by the shield/armor guard', () => {
  const labels = (props) => props.map((p) => p.label);
  const untrained = tierProperties(boltActionRifle, 'untrained');
  assert.ok(labels(untrained).includes('Awkward'));
  assert.ok(!labels(tierProperties(boltActionRifle, 'proficient')).includes('Awkward'));
  assert.ok(!labels(tierProperties(boltActionRifle, 'expert')).includes('Awkward'));

  // Firearm and Loading keep their numeric parameters at every level.
  for (const level of ['untrained', 'proficient', 'expert']) {
    const firearm = tierProperties(boltActionRifle, level).find((p) => p.label === 'Firearm');
    assert.ok(firearm, `${level}: Bolt-Action Rifle has a Firearm property`);
    assert.equal(firearm.raw, 'Firearm (2)');
    assert.equal(firearm.parameter, '2');

    const loading = tierProperties(boltActionRifle, level).find((p) => p.label === 'Loading');
    assert.ok(loading, `${level}: Bolt-Action Rifle has a Loading property`);
    assert.equal(loading.raw, 'Loading (4)');
    assert.equal(loading.parameter, '4');
  }

  // Expert Reload parameter and Disarm are preserved.
  const expert = tierProperties(boltActionRifle, 'expert');
  const expertReload = expert.find((p) => p.label === 'Reload');
  assert.ok(expertReload, 'Expert row has a Reload property');
  assert.equal(expertReload.parameter, 'Object Interaction (single cartridge)');
  assert.ok(labels(expert).includes('Disarm'), 'Expert row grants Disarm');
});

test('tierProperties: all catalog entries yield only known, uniquely-keyed properties', () => {
  const levels = ['untrained', 'proficient', 'expert'];
  for (const entry of equipment) {
    for (const level of levels) {
      const props = tierProperties(entry, level);
      const keys = new Set();
      for (const prop of props) {
        assert.ok(
          KNOWN_PROPERTY_BASES.has(prop.label.toLowerCase()),
          `${entry.id}@${level}: unknown property label "${prop.label}"`
        );
        assert.match(prop.key, /^rme-[a-z0-9-]+$/, `${entry.id}@${level}: stable key`);
        assert.ok(prop.raw.length > 0, `${entry.id}@${level}: non-empty raw`);
        assert.ok(!keys.has(prop.key), `${entry.id}@${level}: duplicate key ${prop.key}`);
        keys.add(prop.key);
      }
    }
  }
});

test('tierProperties: keys are stable kebabs of the property label', () => {
  const props = tierProperties(boltActionRifle, 'untrained');
  const byLabel = new Map(props.map((p) => [p.label, p.key]));
  assert.equal(byLabel.get('Awkward'), 'rme-awkward');
  assert.equal(byLabel.get('Firearm'), 'rme-firearm');
  assert.equal(byLabel.get('Two-Handed'), 'rme-two-handed');
  assert.equal(byLabel.get('Unwieldy'), 'rme-unwieldy');
});
