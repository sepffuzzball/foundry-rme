import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { nativeProfile } from '../src/native-properties.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const catalog = JSON.parse(
  readFileSync(join(__dirname, '..', 'data', 'catalog.json'), 'utf8')
);

function entry(id) {
  const e = catalog.equipment.find((x) => x.id === id);
  assert.ok(e, `missing catalog entry ${id}`);
  return e;
}

// The native dnd5e 6.x keys this module is allowed to promote from RME. Any key
// outside this set (e.g. the RME-only `rme-*` names) must never surface here.
const ALLOWED_NATIVE_KEYS = new Set(['two', 'fin', 'rch', 'ver']);

// Native keys that the module deliberately never auto-maps. A weapon carrying the
// corresponding RME property (Heavy, Light, Loading, Reload, Firearm,
// Ammunition, Thrown, or Ranged) must not have that native key emitted.
const NEVER_MAPPED_NATIVE_KEYS = [
  'hvy',
  'lgt',
  'ldg',
  'rel',
  'fir',
  'amm',
  'thr',
  'rng',
];

// A ranged weapon that carries Reach. Reach maps only for melee weapons, so this
// synthetic entry must not emit `rch`.
const rangedWithReach = {
  id: 'test/ranged-reach',
  group: 'Bows',
  name: 'Ranged Reach',
  kind: 'weapon',
  description:
    '##### Ranged Reach\n\n_Piercing, 1 lb, 1 gp_\n\n' +
    'Untrained Reach, Ranged d6 (20/60)',
  tiers: ['Untrained Reach, Ranged d6 (20/60)'],
};

// A row that is inconsistent about the grip: it lists both Two-Handed and
// Versatile. The native system cannot hold both, so the explicit Two-Handed is
// preferred and the Versatile die is dropped.
const inconsistentGrip = {
  id: 'test/inconsistent-grip',
  group: 'Axes',
  name: 'Inconsistent Grip',
  kind: 'weapon',
  description:
    '##### Inconsistent Grip\n\n_Slashing, 1 lb, 1 gp_\n\n' +
    'Untrained Two-Handed, Versatile d10, Melee d8',
  tiers: ['Untrained Two-Handed, Versatile d10, Melee d8'],
};

// ---------------------------------------------------------------------------
// Two-Handed
// ---------------------------------------------------------------------------

test('nativeProfile: bolt-action rifle at untrained maps two with no versatile', () => {
  const profile = nativeProfile(entry('firearms/bolt-action-rifle'), 'untrained');
  assert.deepEqual(profile, { keys: ['two'], versatile: null });
});

test('nativeProfile: battle axe maps two at untrained and the explicit versatile die per tier', () => {
  assert.deepEqual(nativeProfile(entry('axes/battle-axe'), 'untrained'), {
    keys: ['two'],
    versatile: null,
  });
  assert.deepEqual(nativeProfile(entry('axes/battle-axe'), 'basic'), {
    keys: ['ver'],
    versatile: { number: 1, denomination: 10 },
  });
  assert.deepEqual(nativeProfile(entry('axes/battle-axe'), 'expert'), {
    keys: ['ver'],
    versatile: { number: 1, denomination: 12 },
  });
});

// ---------------------------------------------------------------------------
// Versatile
// ---------------------------------------------------------------------------

test('nativeProfile: heavy club maps the 2d4 versatile die', () => {
  assert.deepEqual(nativeProfile(entry('bludgeons/heavy-club'), 'proficient'), {
    keys: ['ver'],
    versatile: { number: 2, denomination: 4 },
  });
  assert.deepEqual(nativeProfile(entry('bludgeons/heavy-club'), 'untrained'), {
    keys: ['two'],
    versatile: null,
  });
});

test('nativeProfile: break-action revolver maps the parenthesized versatile die per tier', () => {
  assert.deepEqual(nativeProfile(entry('firearms/break-action-revolver'), 'basic'), {
    keys: ['ver'],
    versatile: { number: 1, denomination: 10 },
  });
  assert.deepEqual(nativeProfile(entry('firearms/break-action-revolver'), 'expert'), {
    keys: ['ver'],
    versatile: { number: 1, denomination: 12 },
  });
  assert.deepEqual(nativeProfile(entry('firearms/break-action-revolver'), 'untrained'), {
    keys: ['two'],
    versatile: null,
  });
});

test('nativeProfile: the multi-form whip sword never reports a versatile die', () => {
  // The Whip Sword has two forms, so selectTier returns two rows at every level.
  // Even though the sword form declares Versatile d10 at proficient, the weapon
  // must not be reported versatile (no invented die, no `ver` key).
  const proficient = nativeProfile(entry('whips/whip-sword'), 'proficient');
  assert.equal(proficient.versatile, null);
  assert.ok(!proficient.keys.includes('ver'));
  assert.deepEqual(proficient.keys, ['fin', 'rch']);
});

test('nativeProfile: an inconsistent Two-Handed + Versatile row prefers Two-Handed', () => {
  assert.deepEqual(nativeProfile(inconsistentGrip, 'untrained'), {
    keys: ['two'],
    versatile: null,
  });
});

// ---------------------------------------------------------------------------
// Finesse / Reach
// ---------------------------------------------------------------------------

test('nativeProfile: a melee whip maps Finesse and Reach', () => {
  assert.deepEqual(nativeProfile(entry('whips/scorpion-whip'), 'untrained'), {
    keys: ['fin', 'rch'],
    versatile: null,
  });
});

test('nativeProfile: Finesse maps while Light never does', () => {
  // The shortsword is Finesse and Light; only Finesse is promoted.
  assert.deepEqual(nativeProfile(entry('dueling-blades/shortsword'), 'untrained'), {
    keys: ['fin'],
    versatile: null,
  });
});

test('nativeProfile: Reach is never mapped for a ranged weapon', () => {
  const profile = nativeProfile(rangedWithReach, 'untrained');
  assert.ok(!profile.keys.includes('rch'));
  assert.deepEqual(profile, { keys: [], versatile: null });
});

// ---------------------------------------------------------------------------
// Unsupported native keys
// ---------------------------------------------------------------------------

test('nativeProfile: never auto-maps unsupported native keys across the catalog', () => {
  for (const e of catalog.equipment) {
    for (const level of ['untrained', 'proficient', 'expert']) {
      const profile = nativeProfile(e, level);
      for (const key of profile.keys) {
        assert.ok(
          ALLOWED_NATIVE_KEYS.has(key),
          `${e.id} @ ${level}: unexpected native key ${key}`
        );
        assert.ok(
          !NEVER_MAPPED_NATIVE_KEYS.includes(key),
          `${e.id} @ ${level}: unsupported native key ${key}`
        );
      }
      if (profile.versatile) {
        assert.ok(
          profile.keys.includes('ver'),
          `${e.id} @ ${level}: versatile die present without a ver key`
        );
        assert.ok(Number.isInteger(profile.versatile.number) && profile.versatile.number >= 1);
        assert.ok(
          Number.isInteger(profile.versatile.denomination) &&
            profile.versatile.denomination >= 1
        );
      }
    }
  }
});

test('nativeProfile: bolt-action rifle untrained emits no unsupported native keys', () => {
  // The rifle carries Heavy, Loading, Reload, Firearm, and Ammunition RME
  // properties at untrained; none of their native keys may appear, only `two`.
  const profile = nativeProfile(entry('firearms/bolt-action-rifle'), 'untrained');
  assert.deepEqual(profile.keys, ['two']);
  for (const key of NEVER_MAPPED_NATIVE_KEYS) {
    assert.ok(!profile.keys.includes(key), `unexpected native key ${key}`);
  }
});

// ---------------------------------------------------------------------------
// Runtime independence
// ---------------------------------------------------------------------------

test('nativeProfile: has no Foundry global dependencies', () => {
  // The module must be importable and callable without `game`, `CONFIG`,
  // `foundry`, or `ui`. Any stray reference would throw at import or call time.
  const saved = {};
  for (const g of ['game', 'CONFIG', 'foundry', 'ui']) {
    saved[g] = globalThis[g];
    globalThis[g] = undefined;
  }
  try {
    const profile = nativeProfile(entry('firearms/bolt-action-rifle'), 'untrained');
    assert.deepEqual(profile, { keys: ['two'], versatile: null });
  } finally {
    for (const g of ['game', 'CONFIG', 'foundry', 'ui']) {
      if (saved[g] === undefined) delete globalThis[g];
      else globalThis[g] = saved[g];
    }
  }
});
