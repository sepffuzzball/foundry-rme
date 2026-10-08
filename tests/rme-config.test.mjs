// Tests for registerRmeConfig: registering RME weapon categories and weapon
// properties as dnd5e Item Details choices without disturbing native dnd5e
// entries.
//
// The tests build a CONFIG.DND5E-like object that mirrors the real dnd5e core
// entries (weaponTypes as label strings, weaponTypeMap as melee/ranged hints,
// itemProperties as { label } objects, validProperties.weapon as a Set) and
// then verify that registerRmeConfig adds only RME-namespaced entries.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  RME_WEAPON_GROUPS,
  RME_PROPERTY_NAMES,
  rmeWeaponType,
} from '../src/rme-metadata.mjs';
import { registerRmeConfig } from '../src/rme-config.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));

// The display label for a weapon group, replicating the module's rule (the only
// group that is not rendered verbatim is Hammers Picks).
const groupLabel = (group) =>
  `RME: ${group === 'Hammers Picks' ? 'Hammers and Picks' : group}`;

// Replicate the module's kebab transformation so the tests can derive the
// expected property keys independently of the module constants.
function kebab(text) {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function propertyKey(name) {
  return `rme-${kebab(name.replace(/\s*\(#\)$/, ''))}`;
}

// A CONFIG.DND5E-like object seeded with the native dnd5e entries that RME must
// not disturb, plus the core objects registerRmeConfig requires.
function makeConfig() {
  return {
    weaponTypes: {
      simpleM: 'DND5E.WeaponSimpleM',
      simpleR: 'DND5E.WeaponSimpleR',
      martialM: 'DND5E.WeaponMartialM',
      martialR: 'DND5E.WeaponMartialR',
      natural: 'DND5E.WeaponNatural',
      improv: 'DND5E.WeaponImprov',
      siege: 'DND5E.WeaponSiege',
    },
    weaponTypeMap: {
      simpleM: 'melee',
      simpleR: 'ranged',
      martialM: 'melee',
      martialR: 'ranged',
      siege: 'ranged',
    },
    weaponProficienciesMap: {
      simpleM: 'sim',
      simpleR: 'sim',
      martialM: 'mar',
      martialR: 'mar',
    },
    itemProperties: {
      fin: { label: 'DND5E.ITEM.Property.Finesse' },
      fir: { label: 'DND5E.ITEM.Property.Firearm' },
      hvy: { label: 'DND5E.ITEM.Property.Heavy' },
      lgt: { label: 'DND5E.ITEM.Property.Light' },
      lod: { label: 'DND5E.ITEM.Property.Loading' },
      rch: { label: 'DND5E.ITEM.Property.Reach' },
      rel: { label: 'DND5E.ITEM.Property.Reload' },
      thr: { label: 'DND5E.ITEM.Property.Thrown' },
      two: { label: 'DND5E.ITEM.Property.TwoHanded' },
      ver: { label: 'DND5E.ITEM.Property.Versatile' },
    },
    validProperties: {
      weapon: new Set([
        'ada', 'amm', 'fin', 'fir', 'foc', 'hvy', 'lgt', 'lod',
        'mgc', 'rch', 'rel', 'ret', 'sil', 'spc', 'thr', 'two', 'ver',
      ]),
    },
  };
}

// ---------------------------------------------------------------------------
// Weapon categories
// ---------------------------------------------------------------------------

test('registerRmeConfig registers all 15 weapon groups with correct labels and modes', () => {
  const config = makeConfig();
  const before = structuredClone(config);
  registerRmeConfig(config);

  assert.equal(
    Object.keys(config.weaponTypes).length,
    Object.keys(before.weaponTypes).length + RME_WEAPON_GROUPS.length
  );
  assert.equal(
    Object.keys(config.weaponTypeMap).length,
    Object.keys(before.weaponTypeMap).length + RME_WEAPON_GROUPS.length
  );

  for (const group of RME_WEAPON_GROUPS) {
    const type = rmeWeaponType(group);
    assert.ok(type, `${group}: expected rmeWeaponType to yield a config`);
    assert.ok(
      type.mode === 'melee' || type.mode === 'ranged',
      `${group}: rmeWeaponType mode is melee/ranged`
    );
    assert.ok(config.weaponTypes[type.key], `${group}: weapon type registered`);
    assert.equal(config.weaponTypes[type.key], groupLabel(group), `${group}: display label`);
    assert.equal(config.weaponTypeMap[type.key], type.mode, `${group}: mode hint`);
    // RME weapon types never claim a native simple/martial proficiency.
    assert.equal(config.weaponProficienciesMap[type.key], undefined, `${group}: no sim/mar`);
  }

  // Native weapon types and their melee/ranged map are untouched.
  for (const [key, value] of Object.entries(before.weaponTypes)) {
    assert.equal(config.weaponTypes[key], value, `native weapon type "${key}"`);
  }
  for (const [key, value] of Object.entries(before.weaponTypeMap)) {
    assert.equal(config.weaponTypeMap[key], value, `native weaponTypeMap "${key}"`);
  }
  for (const [key, value] of Object.entries(before.weaponProficienciesMap)) {
    assert.equal(config.weaponProficienciesMap[key], value, `native weaponProficienciesMap "${key}"`);
  }
});

test('Hammers Picks registers as "RME: Hammers and Picks"', () => {
  const config = makeConfig();
  registerRmeConfig(config);

  const { key, mode } = rmeWeaponType('Hammers Picks');
  assert.equal(mode, 'melee');
  assert.equal(config.weaponTypes[key], 'RME: Hammers and Picks');
  assert.equal(config.weaponTypeMap[key], mode);
});

test('a catalog rifle registers as the Firearms weapon type', () => {
  const catalog = JSON.parse(
    readFileSync(join(__dirname, '..', 'data', 'catalog.json'), 'utf8')
  );
  const rifle = catalog.equipment.find((e) => e.id === 'firearms/bolt-action-rifle');
  assert.ok(rifle, 'catalog bolt-action-rifle present');

  const { key, mode } = rmeWeaponType(rifle.group);
  assert.equal(key, 'rmeFirearms');
  assert.equal(mode, 'ranged');

  const config = makeConfig();
  registerRmeConfig(config);
  assert.equal(config.weaponTypes[key], 'RME: Firearms');
  assert.equal(config.weaponTypeMap[key], 'ranged');
  // Native simple/martial proficiencies are NOT claimed for an RME type.
  assert.equal(config.weaponProficienciesMap[key], undefined);
});

// ---------------------------------------------------------------------------
// Weapon properties
// ---------------------------------------------------------------------------

test('registerRmeConfig registers all 42 weapon properties under stable keys', () => {
  const config = makeConfig();
  registerRmeConfig(config);

  assert.equal(RME_PROPERTY_NAMES.length, 42);

  const rmeKeys = Object.keys(config.itemProperties).filter((k) => k.startsWith('rme-'));
  assert.equal(rmeKeys.length, 42, 'exactly 42 RME property keys registered');

  for (const name of RME_PROPERTY_NAMES) {
    const baseName = name.replace(/\s*\(#\)$/, '');
    const key = propertyKey(name);
    assert.match(key, /^rme-[a-z0-9-]+$/, `${baseName}: stable rme-<kebab> key`);
    assert.ok(config.itemProperties[key], `${baseName}: property registered`);
    assert.equal(config.itemProperties[key].label, `RME: ${baseName}`, `${baseName}: label`);
    assert.ok(config.validProperties.weapon.has(key), `${baseName}: key valid for weapons`);
  }
});

test('all 42 property labels align with the WeaponProperties reference', () => {
  const source = readFileSync(
    join(__dirname, '..', 'rules', 'WeaponProperties.md'),
    'utf8'
  );
  const headings = [...source.matchAll(/^##### (.+)$/gm)].map((m) => m[1].trim());
  assert.equal(headings.length, 42);

  const config = makeConfig();
  registerRmeConfig(config);

  for (const heading of headings) {
    const baseName = heading.replace(/\s*\(#\)$/, '');
    const entry = config.itemProperties[propertyKey(heading)];
    assert.ok(entry, `missing property for reference heading "${heading}"`);
    assert.equal(entry.label, `RME: ${baseName}`);
    assert.ok(config.validProperties.weapon.has(propertyKey(heading)));
  }
});

test('native itemProperties and validProperties are left intact', () => {
  const config = makeConfig();
  registerRmeConfig(config);

  assert.deepEqual(config.itemProperties.fin, { label: 'DND5E.ITEM.Property.Finesse' });
  assert.deepEqual(config.itemProperties.fir, { label: 'DND5E.ITEM.Property.Firearm' });
  assert.deepEqual(config.itemProperties.ver, { label: 'DND5E.ITEM.Property.Versatile' });

  // No native weapon property was replaced; every native key is still present.
  for (const key of ['ada', 'amm', 'fin', 'fir', 'foc', 'hvy', 'lgt', 'lod', 'mgc', 'rch', 'rel', 'ret', 'sil', 'spc', 'thr', 'two', 'ver']) {
    assert.ok(config.validProperties.weapon.has(key), `native weapon property "${key}"`);
  }
});

// ---------------------------------------------------------------------------
// Idempotency / preservation
// ---------------------------------------------------------------------------

test('registerRmeConfig is idempotent and never overwrites an existing entry', () => {
  const config = makeConfig();
  registerRmeConfig(config);
  const snapshot = structuredClone(config);

  registerRmeConfig(config);
  assert.deepEqual(config, snapshot);
});

test('registerRmeConfig preserves a pre-existing RME-keyed entry', () => {
  const config = makeConfig();
  // Someone (another module or a prior call) already defined this RME key with a
  // custom label; the registration must not clobber it.
  config.itemProperties['rme-firearm'] = { label: 'Custom Firearm' };
  registerRmeConfig(config);

  assert.deepEqual(config.itemProperties['rme-firearm'], { label: 'Custom Firearm' });
  // The key is still exposed as a valid weapon property.
  assert.ok(config.validProperties.weapon.has('rme-firearm'));
});

// ---------------------------------------------------------------------------
// Error handling
// ---------------------------------------------------------------------------

test('registerRmeConfig throws a helpful error only for missing core config objects', () => {
  const valid = {
    weaponTypes: {},
    weaponTypeMap: {},
    itemProperties: {},
    validProperties: { weapon: new Set() },
  };

  assert.throws(() => registerRmeConfig(null), /registerRmeConfig: expected a CONFIG\.DND5E-like/);
  assert.throws(() => registerRmeConfig({}), /"weaponTypes"/);

  assert.throws(
    () => registerRmeConfig({ ...valid, weaponTypes: undefined }),
    /"weaponTypes"/
  );
  assert.throws(
    () => registerRmeConfig({ ...valid, weaponTypeMap: undefined }),
    /"weaponTypeMap"/
  );
  assert.throws(
    () => registerRmeConfig({ ...valid, itemProperties: undefined }),
    /"itemProperties"/
  );
  assert.throws(
    () => registerRmeConfig({ weaponTypes: {}, weaponTypeMap: {}, itemProperties: {} }),
    /"validProperties"/
  );
  assert.throws(
    () => registerRmeConfig({ ...valid, validProperties: {} }),
    /validProperties\.weapon/
  );

  // A complete config does not throw.
  assert.doesNotThrow(() => registerRmeConfig(valid));
});
