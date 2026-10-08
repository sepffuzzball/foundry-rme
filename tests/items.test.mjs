import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  makeItemData,
  itemProfilePatch,
  syncActorItems,
  reloadActivityData,
  FLAGS_KEY,
  ATTACK_ID,
  RELOAD_FULL_ID,
  RELOAD_FAST_ID,
} from '../src/items.mjs';
import { tierProperties } from '../src/rme-metadata.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const catalog = JSON.parse(
  readFileSync(join(__dirname, '..', 'data', 'catalog.json'), 'utf8')
);

function entry(id) {
  const e = catalog.equipment.find((x) => x.id === id);
  assert.ok(e, `missing catalog entry ${id}`);
  return e;
}

const battleAxe = entry('axes/battle-axe');
const shortbow = entry('bows/shortbow');
const lightCrossbow = entry('crossbows/light-crossbow');
const buckler = entry('shields/buckler');
const chainShirt = entry('armor/chain-shirt');
const claw = entry('natural-weapons/claw');
const tail = entry('natural-weapons/tail');
const boltActionRifle = entry('firearms/bolt-action-rifle');
const breakActionRevolver = entry('firearms/break-action-revolver');
const repeatingCrossbow = entry('crossbows/repeating-crossbow');
const spinner = entry('crossbows/spinner');

// Synthetic malformed-mode entries used to exercise the conservative parser.
const twoMeleeWeapon = {
  id: 'test/two-melee',
  group: 'Test',
  name: 'Two Melee',
  kind: 'weapon',
  description: '##### Two Melee\n\n_Slashing, 1 lb, 1 gp_\n\nUntrained One-Handed, Melee d6, Melee d8',
  tiers: ['Untrained One-Handed, Melee d6, Melee d8'],
};

const hybridWeapon = {
  id: 'test/hybrid',
  group: 'Test',
  name: 'Hybrid',
  kind: 'weapon',
  description: '##### Hybrid\n\n_Piercing, 1 lb, 1 gp_\n\nUntrained One-Handed, Melee d6, Ranged d8 (20/60)',
  tiers: ['Untrained One-Handed, Melee d6, Ranged d8 (20/60)'],
};

const noDieWeapon = {
  id: 'test/no-die',
  group: 'Test',
  name: 'No Die',
  kind: 'weapon',
  description: '##### No Die\n\n_Bludgeoning, 1 lb, 1 gp_\n\nUntrained One-Handed, Melee.',
  tiers: ['Untrained One-Handed, Melee.'],
};

const xssWeapon = {
  id: 'test/xss',
  group: 'Test',
  name: 'XSS',
  kind: 'weapon',
  description:
    '##### XSS\n\n_Slashing, 1 lb, 1 gp_\n\n<b>Bold</b> <script>alert("x")</script>',
  tiers: ['Untrained One-Handed, Melee d6'],
};

// Synthetic entries used to exercise moving an actor item off a parseable
// ranged tier into a tier with no single unambiguous attack profile (or a sole
// melee profile), where previously synced native damage/range must be cleared.
const rangedThenAmbiguous = {
  id: 'test/ranged-then-ambiguous',
  group: 'Test',
  name: 'Ranged Then Ambiguous',
  kind: 'weapon',
  description:
    '##### Ranged Then Ambiguous\n\n_Piercing, 1 lb, 1 gp_\n\n' +
    'Untrained One-Handed, Ranged d8 (20/60)\n' +
    'Basic One-Handed, Ranged d8 (20/60), Melee d6',
  tiers: [
    'Untrained One-Handed, Ranged d8 (20/60)',
    'Basic One-Handed, Ranged d8 (20/60), Melee d6',
  ],
};

const rangedThenMelee = {
  id: 'test/ranged-then-melee',
  group: 'Test',
  name: 'Ranged Then Melee',
  kind: 'weapon',
  description:
    '##### Ranged Then Melee\n\n_Piercing, 1 lb, 1 gp_\n\n' +
    'Untrained One-Handed, Ranged d6 (20/60)\n' +
    'Basic One-Handed, Melee d8',
  tiers: [
    'Untrained One-Handed, Ranged d6 (20/60)',
    'Basic One-Handed, Melee d8',
  ],
};

// The module-owned flag block an entry should carry at a resolved level. Used to
// assert that makeItemData / itemProfilePatch write the expected flag metadata.
function expectedFlags(entryLike, level) {
  const normalized = level === 'basic' ? 'proficient' : level;
  return {
    catalogId: entryLike.id,
    group: entryLike.group,
    activeTier: normalized,
    activeProperties: tierProperties(entryLike, normalized),
    expertPerk: entryLike.expertPerk || null,
  };
}

function propsOf(entryLike, level) {
  return tierProperties(entryLike, level).map((p) => p.key);
}

// ---------------------------------------------------------------------------
// makeItemData - battle axe (melee weapon)
// ---------------------------------------------------------------------------

test('makeItemData: battle axe maps to the RME melee category with stats and flags', () => {
  const data = makeItemData(battleAxe, 'proficient');
  assert.equal(data.name, 'Battle Axe');
  assert.equal(data.type, 'weapon');
  assert.deepEqual(data.flags[FLAGS_KEY], expectedFlags(battleAxe, 'proficient'));
  assert.equal(data.system.type.value, 'rmeAxes');
  assert.equal(data.system.proficient, 1);
  assert.deepEqual(data.system.weight, { value: 4, units: 'lb' });
  assert.deepEqual(data.system.price, { value: 10, denomination: 'gp' });
  assert.deepEqual(data.system.properties, propsOf(battleAxe, 'proficient'));
  assert.deepEqual(data.system.damage.base, {
    number: 1,
    denomination: 8,
    bonus: '',
    types: ['slashing'],
  });
  assert.equal(data.system.range, undefined);
  assert.equal(data.system.activities, undefined);
  assert.ok(data.system.description.value.startsWith('<pre>'));
  assert.ok(data.system.description.value.endsWith('</pre>'));
  assert.ok(data.system.description.value.includes('##### Battle Axe'));
  assert.ok(data.system.description.value.includes('_Slashing, 4 lbs, 10 gp_'));
});

test('makeItemData: battle axe default level is untrained (proficient 0)', () => {
  const data = makeItemData(battleAxe);
  assert.equal(data.system.proficient, 0);
  assert.equal(data.system.type.value, 'rmeAxes');
});

test('makeItemData: an unknown level falls back to untrained', () => {
  const data = makeItemData(battleAxe, 'master');
  assert.equal(data.system.proficient, 0);
  assert.equal(data.system.type.value, 'rmeAxes');
});

test('makeItemData: expert level maps the expert damage token', () => {
  const data = makeItemData(battleAxe, 'expert');
  assert.equal(data.system.proficient, 1);
  assert.deepEqual(data.system.damage.base, {
    number: 1,
    denomination: 10,
    bonus: '',
    types: ['slashing'],
  });
});

// ---------------------------------------------------------------------------
// makeItemData - ranged weapons
// ---------------------------------------------------------------------------

test('makeItemData: shortbow maps to the RME bows category with range and physical stats', () => {
  const data = makeItemData(shortbow, 'proficient');
  assert.equal(data.type, 'weapon');
  assert.equal(data.system.type.value, 'rmeBows');
  assert.equal(data.system.proficient, 1);
  assert.deepEqual(data.system.weight, { value: 2, units: 'lb' });
  assert.deepEqual(data.system.price, { value: 25, denomination: 'gp' });
  assert.deepEqual(data.system.properties, propsOf(shortbow, 'proficient'));
  assert.deepEqual(data.system.damage.base, {
    number: 1,
    denomination: 6,
    bonus: '',
    types: ['piercing'],
  });
  assert.deepEqual(data.system.range, { value: 80, long: 320, units: 'ft' });
  assert.equal(data.system.activities, undefined);
});

test('makeItemData: light crossbow maps a single +3 ranged token to base damage', () => {
  const data = makeItemData(lightCrossbow, 'proficient');
  assert.equal(data.system.type.value, 'rmeCrossbows');
  assert.equal(data.system.proficient, 1);
  assert.deepEqual(data.system.damage.base, {
    number: 1,
    denomination: 8,
    bonus: '3',
    types: ['piercing'],
  });
  assert.deepEqual(data.system.range, { value: 80, long: 320, units: 'ft' });
});

// ---------------------------------------------------------------------------
// makeItemData - shield and armor
// ---------------------------------------------------------------------------

test('makeItemData: shield maps to equipment with shield type, AC bonus, and physical stats', () => {
  const data = makeItemData(buckler, 'proficient');
  assert.equal(data.type, 'equipment');
  assert.equal(data.system.type.value, 'shield');
  assert.equal(data.system.proficient, 1);
  assert.equal(data.system.armor.value, 1);
  assert.deepEqual(data.system.weight, { value: 2, units: 'lb' });
  assert.deepEqual(data.system.price, { value: 5, denomination: 'gp' });
  assert.equal(data.system.damage, undefined);
  assert.equal(data.system.properties, undefined);
  assert.equal(data.system.activities, undefined);
});

test('makeItemData: armor maps to equipment with an inferred category, numeric AC, and physical stats', () => {
  const data = makeItemData(chainShirt, 'proficient');
  assert.equal(data.type, 'equipment');
  assert.equal(data.system.type.value, 'medium');
  assert.equal(data.system.proficient, 1);
  assert.equal(data.system.armor.value, 13);
  assert.deepEqual(data.system.weight, { value: 10, units: 'lb' });
  assert.deepEqual(data.system.price, { value: 50, denomination: 'gp' });
});

test('makeItemData: armor category is an explicit name lookup with parsed physical stats', () => {
  const leather = makeItemData(entry('armor/leather'), 'proficient');
  const plate = makeItemData(entry('armor/plate'), 'proficient');
  assert.equal(leather.system.type.value, 'light');
  assert.equal(leather.system.armor.value, 11);
  assert.deepEqual(leather.system.weight, { value: 5, units: 'lb' });
  assert.deepEqual(leather.system.price, { value: 10, denomination: 'gp' });
  assert.equal(plate.system.type.value, 'heavy');
  assert.equal(plate.system.armor.value, 18);
  assert.deepEqual(plate.system.weight, { value: 40, units: 'lb' });
  assert.deepEqual(plate.system.price, { value: 1500, denomination: 'gp' });
});

// ---------------------------------------------------------------------------
// makeItemData - malformed modes
// ---------------------------------------------------------------------------

test('makeItemData: two melee tokens are ambiguous and suppressed', () => {
  const data = makeItemData(twoMeleeWeapon, 'untrained');
  assert.equal(data.system.type.value, 'simpleM');
  assert.equal(data.system.damage, undefined);
  assert.equal(data.system.range, undefined);
  assert.deepEqual(data.system.activities, {});
  assert.deepEqual(data.system.weight, { value: 1, units: 'lb' });
  assert.deepEqual(data.system.price, { value: 1, denomination: 'gp' });
});

test('makeItemData: a mixed melee/ranged row is ambiguous and sets no range', () => {
  const data = makeItemData(hybridWeapon, 'untrained');
  assert.equal(data.system.type.value, 'simpleM');
  assert.equal(data.system.damage, undefined);
  assert.equal(data.system.range, undefined);
  assert.deepEqual(data.system.activities, {});
});

test('makeItemData: a melee keyword with no die stays melee without base damage', () => {
  const data = makeItemData(noDieWeapon, 'untrained');
  assert.equal(data.system.type.value, 'simpleM');
  assert.equal(data.system.damage, undefined);
  assert.deepEqual(data.system.activities, {});
});

// ---------------------------------------------------------------------------
// makeItemData - natural weapons and XSS
// ---------------------------------------------------------------------------

test('makeItemData: natural weapons use the natural type, suppress activities, and get no physical stats', () => {
  const data = makeItemData(claw, 'proficient');
  assert.equal(data.type, 'weapon');
  assert.equal(data.system.type.value, 'natural');
  assert.equal(data.system.proficient, 1);
  assert.equal(data.system.damage, undefined);
  assert.deepEqual(data.system.activities, {});
  assert.equal(data.system.weight, undefined);
  assert.equal(data.system.price, undefined);
  assert.deepEqual(data.system.properties, propsOf(claw, 'proficient'));
});

test('makeItemData: escapes HTML in the description and wraps it in <pre>', () => {
  const data = makeItemData(xssWeapon, 'untrained');
  const value = data.system.description.value;
  assert.ok(value.startsWith('<pre>'));
  assert.ok(value.endsWith('</pre>'));
  assert.ok(value.includes('&lt;b&gt;Bold&lt;/b&gt;'));
  assert.ok(value.includes('&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;'));
  assert.ok(!value.includes('<script>'));
  assert.ok(!value.includes('<b>'));
});

// ---------------------------------------------------------------------------
// makeItemData - RME category / properties / physical stats
// ---------------------------------------------------------------------------

test('makeItemData: bolt-action rifle carries parsed physical stats and the RME firearms type', () => {
  const data = makeItemData(boltActionRifle, 'untrained');
  assert.equal(data.system.type.value, 'rmeFirearms');
  assert.deepEqual(data.system.weight, { value: 12, units: 'lb' });
  assert.deepEqual(data.system.price, { value: 1000, denomination: 'gp' });
  assert.deepEqual(data.flags[FLAGS_KEY], expectedFlags(boltActionRifle, 'untrained'));
});

test('makeItemData: bolt-action rifle at untrained surfaces the Awkward property', () => {
  const data = makeItemData(boltActionRifle, 'untrained');
  assert.ok(data.system.properties.includes('rme-awkward'));
  assert.ok(data.flags[FLAGS_KEY].activeProperties.some((p) => p.label === 'Awkward'));
});

test('makeItemData: bolt-action rifle at Basic drops Awkward and maps the 2d8 (200/800) profile', () => {
  const basic = makeItemData(boltActionRifle, 'basic');
  const proficient = makeItemData(boltActionRifle, 'proficient');
  assert.equal(basic.flags[FLAGS_KEY].activeTier, 'proficient');
  assert.ok(!basic.system.properties.includes('rme-awkward'));
  assert.deepEqual(basic.system.damage.base, {
    number: 2,
    denomination: 8,
    bonus: '',
    types: ['piercing'],
  });
  assert.deepEqual(basic.system.range, { value: 200, long: 800, units: 'ft' });
  // "basic" is an alias for the Basic/Proficient tier.
  assert.deepEqual(basic.system.properties, proficient.system.properties);
});

test('makeItemData: bolt-action rifle at Expert grants Disarm, the 2d8 (250/1000) profile, and the perk', () => {
  const data = makeItemData(boltActionRifle, 'expert');
  assert.ok(data.system.properties.includes('rme-disarm'));
  assert.deepEqual(data.system.damage.base, {
    number: 2,
    denomination: 8,
    bonus: '',
    types: ['piercing'],
  });
  assert.deepEqual(data.system.range, { value: 250, long: 1000, units: 'ft' });
  assert.equal(data.flags[FLAGS_KEY].activeTier, 'expert');
  assert.equal(data.flags[FLAGS_KEY].expertPerk, boltActionRifle.expertPerk);
});

test('makeItemData: natural weapons never fabricate weight or price at any level', () => {
  const clawData = makeItemData(claw, 'expert');
  const tailData = makeItemData(tail, 'expert');
  assert.equal(clawData.system.weight, undefined);
  assert.equal(clawData.system.price, undefined);
  assert.equal(tailData.system.weight, undefined);
  assert.equal(tailData.system.price, undefined);
});

// ---------------------------------------------------------------------------
// makeItemData - magazine reload activities
// ---------------------------------------------------------------------------

test('makeItemData: a magazine rifle includes the default attack and full reload activity', () => {
  const data = makeItemData(boltActionRifle, 'untrained');
  assert.deepEqual(Object.keys(data.system.activities).sort(), [ATTACK_ID, RELOAD_FULL_ID]);
  assert.equal(data.system.activities[ATTACK_ID]._id, ATTACK_ID);
  assert.equal(data.system.activities[ATTACK_ID].type, 'attack');
  assert.equal(data.system.activities[ATTACK_ID].name, 'Attack');
  assert.equal(data.system.activities[ATTACK_ID].sort, 0);
  const full = data.system.activities[RELOAD_FULL_ID];
  assert.equal(full._id, RELOAD_FULL_ID);
  assert.equal(full.type, 'utility');
  assert.equal(full.sort, 1);
  assert.equal(full.name, 'RME Reload (Action)');
  assert.deepEqual(full.activation, {
    type: 'action',
    value: 1,
    condition: 'Reload (Action)',
    override: false,
  });
  assert.equal(full.flags[FLAGS_KEY].reloadOptionId, 'action-full');
  // Untrained rifle has no faster reload, so no stale fast activity is present.
  assert.equal(data.system.activities[RELOAD_FAST_ID], undefined);
});

test('makeItemData: an expert magazine rifle adds the single-cartridge object-interaction reload', () => {
  const data = makeItemData(boltActionRifle, 'expert');
  const fast = data.system.activities[RELOAD_FAST_ID];
  assert.equal(fast._id, RELOAD_FAST_ID);
  assert.equal(fast.type, 'utility');
  assert.equal(fast.sort, 2);
  assert.equal(fast.name, 'RME Reload (Object Interaction (single cartridge))');
  assert.equal(fast.activation.type, 'special');
  assert.equal(fast.activation.condition, 'Reload (Object Interaction (single cartridge))');
  assert.equal(fast.flags[FLAGS_KEY].reloadOptionId, 'special-single');
});

test('makeItemData: repeating crossbow and spinner carry reload activities with a free reload', () => {
  for (const weapon of [repeatingCrossbow, spinner]) {
    const data = makeItemData(weapon, 'proficient');
    assert.deepEqual(Object.keys(data.system.activities).sort(), [ATTACK_ID, RELOAD_FULL_ID, RELOAD_FAST_ID].sort());
    const fast = data.system.activities[RELOAD_FAST_ID];
    assert.equal(fast.activation.type, 'special');
    assert.equal(fast.activation.condition, 'Reload (Free)');
    assert.equal(fast.flags[FLAGS_KEY].reloadOptionId, 'special-full');
  }
});

test('makeItemData: a magazine weapon attack uses a valid 16-char module id', () => {
  // The module default attack id must be a stable, exactly-16-ASCII-character
  // Foundry embedded-key, never a short id like "attack" that dnd5e would
  // reject. The same id is used for the activity's own _id and its mapping key.
  assert.equal(ATTACK_ID.length, 16);
  assert.match(ATTACK_ID, /^[a-zA-Z0-9]{16}$/);
  for (const weapon of [boltActionRifle, repeatingCrossbow, spinner]) {
    const data = makeItemData(weapon, 'proficient');
    const activity = data.system.activities[ATTACK_ID];
    assert.ok(activity, `expected the module default attack activity on ${weapon.id}`);
    assert.equal(activity._id, ATTACK_ID);
    assert.equal(activity._id.length, 16);
    assert.equal(activity.type, 'attack');
    // The activities object key is the same 16-char id as the _id.
    assert.ok(data.system.activities[ATTACK_ID]);
  }
});

// ---------------------------------------------------------------------------
// itemProfilePatch
// ---------------------------------------------------------------------------

test('itemProfilePatch: weapon returns only module-owned fields', () => {
  const item = { _id: 'item-1', system: { proficient: 1 } };
  const patch = itemProfilePatch(item, battleAxe, 'proficient');
  assert.deepEqual(patch, {
    _id: 'item-1',
    system: {
      proficient: 1,
      type: { value: 'rmeAxes' },
      properties: propsOf(battleAxe, 'proficient'),
      weight: { value: 4, units: 'lb' },
      price: { value: 10, denomination: 'gp' },
      damage: {
        base: { number: 1, denomination: 8, bonus: '', types: ['slashing'] },
      },
    },
    flags: { [FLAGS_KEY]: expectedFlags(battleAxe, 'proficient') },
  });
});

test('itemProfilePatch: ranged weapon includes range only for a sole ranged profile', () => {
  const item = { _id: 'item-2', system: { proficient: 0 } };
  const patch = itemProfilePatch(item, shortbow, 'proficient');
  assert.deepEqual(patch, {
    _id: 'item-2',
    system: {
      proficient: 1,
      type: { value: 'rmeBows' },
      properties: propsOf(shortbow, 'proficient'),
      weight: { value: 2, units: 'lb' },
      price: { value: 25, denomination: 'gp' },
      damage: {
        base: { number: 1, denomination: 6, bonus: '', types: ['piercing'] },
      },
      range: { value: 80, long: 320, units: 'ft' },
    },
    flags: { [FLAGS_KEY]: expectedFlags(shortbow, 'proficient') },
  });
});

test('itemProfilePatch: armor returns type, proficient, and repaired physical stats', () => {
  const item = { _id: 'item-3', system: { proficient: 1 } };
  const patch = itemProfilePatch(item, chainShirt, 'proficient');
  assert.deepEqual(patch, {
    _id: 'item-3',
    system: {
      proficient: 1,
      type: { value: 'medium' },
      weight: { value: 10, units: 'lb' },
      price: { value: 50, denomination: 'gp' },
    },
    flags: { [FLAGS_KEY]: expectedFlags(chainShirt, 'proficient') },
  });
});

test('itemProfilePatch: a weapon without parseable damage syncs proficiency, type, and properties', () => {
  const item = { _id: 'item-4', system: { proficient: 0 } };
  const patch = itemProfilePatch(item, claw, 'proficient');
  assert.deepEqual(patch, {
    _id: 'item-4',
    system: {
      proficient: 1,
      type: { value: 'natural' },
      properties: propsOf(claw, 'proficient'),
    },
    flags: { [FLAGS_KEY]: expectedFlags(claw, 'proficient') },
  });
});

test('itemProfilePatch: preserves an existing damage bonus and types', () => {
  const item = {
    _id: 'item-5',
    system: {
      proficient: 1,
      damage: {
        base: {
          number: 1,
          denomination: 8,
          bonus: '2',
          types: ['slashing', 'radiant'],
        },
      },
    },
  };
  const patch = itemProfilePatch(item, battleAxe, 'proficient');
  assert.deepEqual(patch.system.damage.base, {
    number: 1,
    denomination: 8,
    bonus: '2',
    types: ['slashing', 'radiant'],
  });
});

test('itemProfilePatch: an ambiguous tier zeroes native damage and clears range, preserving bonus/types', () => {
  const item = {
    _id: 'rta-1',
    system: {
      proficient: 1,
      damage: {
        base: { number: 1, denomination: 8, bonus: '2', types: ['piercing', 'radiant'] },
      },
      range: { value: 20, long: 60, units: 'ft' },
    },
  };
  const patch = itemProfilePatch(item, rangedThenAmbiguous, 'proficient');
  assert.deepEqual(patch.system.damage.base, {
    number: 0,
    denomination: 0,
    bonus: '2',
    types: ['piercing', 'radiant'],
  });
  assert.deepEqual(patch.system.range, { value: null, long: null, units: 'ft' });
  assert.equal(patch.system.proficient, 1);
});

test('itemProfilePatch: moving to a sole melee tier clears stale range and writes melee damage', () => {
  const item = {
    _id: 'rtm-1',
    system: {
      proficient: 0,
      damage: {
        base: { number: 1, denomination: 6, bonus: '2', types: ['piercing'] },
      },
      range: { value: 20, long: 60, units: 'ft' },
    },
  };
  const patch = itemProfilePatch(item, rangedThenMelee, 'proficient');
  assert.deepEqual(patch.system.damage.base, {
    number: 1,
    denomination: 8,
    bonus: '2',
    types: ['piercing'],
  });
  assert.deepEqual(patch.system.range, { value: null, long: null, units: 'ft' });
  assert.equal(patch.system.proficient, 1);
});

test('itemProfilePatch: ambiguous tier does not spurious-write damage/range on a blank item', () => {
  const item = { _id: 'blank-1', system: { proficient: 1 } };
  const patch = itemProfilePatch(item, rangedThenAmbiguous, 'proficient');
  assert.equal(patch.system.damage, undefined);
  assert.equal(patch.system.range, undefined);
});

test('itemProfilePatch: sole melee tier does not write a null range onto a blank item', () => {
  const item = { _id: 'blank-2', system: { proficient: 0 } };
  const patch = itemProfilePatch(item, rangedThenMelee, 'proficient');
  assert.deepEqual(patch.system.damage.base, {
    number: 1,
    denomination: 8,
    bonus: '',
    types: ['piercing'],
  });
  assert.equal(patch.system.range, undefined);
});

test('itemProfilePatch: preserves native and unrelated properties while replacing only rme-* keys', () => {
  const item = {
    _id: 'x1',
    system: {
      proficient: 1,
      properties: ['fir', 'rch', 'rme-awkward', 'rme-heavy'],
    },
  };
  const patch = itemProfilePatch(item, boltActionRifle, 'proficient');
  const props = patch.system.properties;
  assert.ok(props.includes('fir'));
  assert.ok(props.includes('rch'));
  assert.ok(props.includes('rme-heavy'));
  assert.ok(!props.includes('rme-awkward'));
  assert.deepEqual(
    [...props].sort(),
    [...new Set([...propsOf(boltActionRifle, 'proficient'), 'fir', 'rch'])].sort()
  );
});

test('itemProfilePatch: clears stale rme-* keys not granted by the selected tier', () => {
  const item = {
    _id: 'x2',
    system: { proficient: 1, properties: ['fir', 'rme-awkward', 'rme-hipshot'] },
  };
  const patch = itemProfilePatch(item, boltActionRifle, 'proficient');
  assert.deepEqual(patch.system.properties, [
    'fir',
    ...propsOf(boltActionRifle, 'proficient'),
  ]);
});

test('itemProfilePatch: repairs zero/missing weight and price but never overwrites a nonzero user value', () => {
  const zero = {
    _id: 'z1',
    system: {
      proficient: 1,
      weight: { value: 0, units: 'lb' },
      price: { value: 0, denomination: 'gp' },
    },
  };
  const patch = itemProfilePatch(zero, boltActionRifle, 'proficient');
  assert.deepEqual(patch.system.weight, { value: 12, units: 'lb' });
  assert.deepEqual(patch.system.price, { value: 1000, denomination: 'gp' });

  const nonzero = {
    _id: 'n1',
    system: {
      proficient: 1,
      weight: { value: 3, units: 'oz' },
      price: { value: 50, denomination: 'gp' },
    },
  };
  const patch2 = itemProfilePatch(nonzero, boltActionRifle, 'proficient');
  assert.equal(patch2.system.weight, undefined);
  assert.equal(patch2.system.price, undefined);
});

test('itemProfilePatch: a magazine weapon adds reload activity keys as dotted system paths', () => {
  const item = { _id: 'r1', system: { proficient: 1 } };
  const patch = itemProfilePatch(item, boltActionRifle, 'proficient');
  const full = patch.system[`activities.${RELOAD_FULL_ID}`];
  assert.ok(full, 'expected the full reload activity key on the patch');
  assert.equal(full._id, RELOAD_FULL_ID);
  assert.equal(full.type, 'utility');
  assert.equal(full.name, 'RME Reload (Action)');
  assert.equal(full.activation.type, 'action');
  assert.equal(full.flags[FLAGS_KEY].reloadOptionId, 'action-full');
  // A blank magazine weapon has no attack, so the module-owned default attack is
  // written through the same granular dotted path.
  const attack = patch.system[`activities.${ATTACK_ID}`];
  assert.ok(attack, 'expected the module default attack activity key on the patch');
  assert.equal(attack._id, ATTACK_ID);
  assert.equal(attack.type, 'attack');
  assert.equal(attack.name, 'Attack');
  assert.equal(attack.sort, 0);
  // No stale fast activity exists on a blank item, so no deletion operator is written.
  assert.equal(patch.system[`activities.-=${RELOAD_FAST_ID}`], undefined);
  // The patch never carries the whole activities collection or a user activity id.
  assert.equal(patch.system.activities, undefined);
});

test('itemProfilePatch: a magazine weapon at expert writes the fast reload activity key', () => {
  const item = { _id: 'r2', system: { proficient: 1 } };
  const patch = itemProfilePatch(item, breakActionRevolver, 'expert');
  const fast = patch.system[`activities.${RELOAD_FAST_ID}`];
  assert.ok(fast, 'expected the fast reload activity key on the patch');
  assert.equal(fast.activation.type, 'bonus');
  assert.equal(fast.activation.condition, 'Reload (Bonus)');
  assert.equal(fast.flags[FLAGS_KEY].reloadOptionId, 'bonus-full');
});

test('itemProfilePatch: drops a stale fast reload when the tier no longer grants it', () => {
  const item = {
    _id: 'r3',
    system: {
      proficient: 1,
      activities: {
        attack: { _id: 'attack', type: 'attack', name: 'Attack' },
        [RELOAD_FULL_ID]: {
          _id: RELOAD_FULL_ID,
          type: 'utility',
          name: 'RME Reload (Action)',
          activation: { type: 'action', value: 1, condition: 'Reload (Action)', override: false },
        },
        [RELOAD_FAST_ID]: {
          _id: RELOAD_FAST_ID,
          type: 'utility',
          name: 'RME Reload (Bonus)',
          activation: { type: 'bonus', value: 1, condition: 'Reload (Bonus)', override: false },
        },
      },
    },
  };
  // At proficient the break-action revolver grants only the full reload.
  const patch = itemProfilePatch(item, breakActionRevolver, 'proficient');
  assert.equal(patch.system[`activities.-=${RELOAD_FAST_ID}`], null);
  assert.ok(patch.system[`activities.${RELOAD_FULL_ID}`]);
  // A native attack already exists, so the module default attack is not written on top.
  assert.equal(patch.system[`activities.${ATTACK_ID}`], undefined);
  // The native attack activity and any user activity id are left untouched.
  assert.equal(patch.system.activities, undefined);
});

// ---------------------------------------------------------------------------
// syncActorItems - mock helpers
// ---------------------------------------------------------------------------

function setPath(obj, path, value) {
  const parts = path.split('.');
  let cur = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    const key = parts[i];
    if (cur instanceof Map) {
      let next = cur.get(key);
      if (!next || typeof next !== 'object') {
        next = {};
        cur.set(key, next);
      }
      cur = next;
    } else {
      if (!cur[key] || typeof cur[key] !== 'object') cur[key] = {};
      cur = cur[key];
    }
  }
  const last = parts[parts.length - 1];
  if (cur instanceof Map) {
    cur.set(last, value);
  } else {
    cur[last] = value;
  }
}

function deletePath(obj, path) {
  const parts = path.split('.');
  let cur = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    const key = parts[i];
    cur = cur?.[key];
    if (!cur) return;
  }
  const last = parts[parts.length - 1];
  if (cur instanceof Map) {
    cur.delete(last);
  } else {
    delete cur[last];
  }
}

function mergeItem(item, update) {
  const merged = { ...item, system: { ...item.system } };
  for (const [key, value] of Object.entries(update.system)) {
    // A `.-=` key is the Foundry deletion operator: remove that nested key.
    const del = key.indexOf('.-=');
    if (del !== -1) {
      deletePath(merged.system, `${key.slice(0, del)}.${key.slice(del + 3)}`);
    } else if (key.includes('.')) {
      // A dotted key expands into nested objects, never replacing siblings.
      setPath(merged.system, key, value);
    } else if (value && typeof value === 'object' && !Array.isArray(value)) {
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
  return merged;
}

function makeActor(items) {
  let lastUpdates = null;
  const actor = {
    items,
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
  return actor;
}

// Build the exact module-owned target state for an entry at a level, using the
// same mapper, so idempotency assertions can construct a fully-matching item.
function fullySyncedState(entryLike, level) {
  const data = makeItemData(entryLike, level);
  const system = { ...data.system };
  delete system.description;
  return { flags: { [FLAGS_KEY]: data.flags[FLAGS_KEY] }, system };
}

// Build a live-like dnd5e 6.x activity collection: a Map whose entries are the
// module-owned activities keyed by id, as a live MappingField/Collection would
// expose them (`.get(id)` and `.values()`), instead of a plain serialized object.
function activitiesMap(activitiesObj) {
  return new Map(Object.entries(activitiesObj));
}

// ---------------------------------------------------------------------------
// syncActorItems - idempotency and scope
// ---------------------------------------------------------------------------

test('syncActorItems: is idempotent and writes nothing when fields already match', async () => {
  const items = [{ _id: 'i1', ...fullySyncedState(battleAxe, 'proficient') }];
  const actor = makeActor(items);
  const training = { groups: { Axes: 'proficient' } };
  const updates = await syncActorItems(actor, catalog.equipment, training);
  assert.deepEqual(updates, []);
  assert.equal(actor.__lastUpdates(), null);
});

test('syncActorItems: writes only when a module-owned field differs, then stops', async () => {
  const items = [
    {
      _id: 'i1',
      flags: { [FLAGS_KEY]: { catalogId: 'axes/battle-axe' } },
      system: { proficient: 0 },
    },
  ];
  const actor = makeActor(items);
  const training = { groups: { Axes: 'proficient' } };
  const expected = itemProfilePatch(
    { _id: 'i1', flags: { [FLAGS_KEY]: { catalogId: 'axes/battle-axe' } }, system: { proficient: 0 } },
    battleAxe,
    'proficient'
  );

  const first = await syncActorItems(actor, catalog.equipment, training);
  assert.equal(first.length, 1);
  assert.deepEqual(first[0], expected);

  // After the mock applies the update, a second run is a no-op.
  const second = await syncActorItems(actor, catalog.equipment, training);
  assert.deepEqual(second, []);
});

test('syncActorItems: updates dice but preserves a user damage bonus, activities, and enchants', async () => {
  const items = [
    {
      _id: 'i1',
      flags: { [FLAGS_KEY]: { catalogId: 'axes/battle-axe' } },
      system: {
        proficient: 0,
        damage: { base: { number: 1, denomination: 6, bonus: '2', types: ['slashing'] } },
        activities: { attack: { id: 'a' } },
        magicalBonus: 1,
      },
    },
  ];
  const actor = makeActor(items);
  const training = { groups: { Axes: 'proficient' } };

  const updates = await syncActorItems(actor, catalog.equipment, training);
  assert.equal(updates.length, 1);
  const patch = updates[0];
  assert.equal(patch.system.proficient, 1);
  assert.deepEqual(patch.system.damage.base, {
    number: 1,
    denomination: 8,
    bonus: '2',
    types: ['slashing'],
  });
  // The module-owned patch never carries these fields; they survive the merge.
  assert.equal(patch.system.activities, undefined);
  assert.equal(patch.system.magicalBonus, undefined);
  assert.equal(items[0].system.activities.attack.id, 'a');
  assert.equal(items[0].system.magicalBonus, 1);
});

test('syncActorItems: leaves unknown items and non-owned data untouched', async () => {
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
      system: { proficient: 0, magicalBonus: 1, name: 'Custom' },
    },
  ];
  const actor = makeActor(items);
  const training = { groups: { Axes: 'proficient' } };

  const updates = await syncActorItems(actor, catalog.equipment, training);
  assert.equal(updates.length, 1);
  assert.equal(updates[0]._id, 'k1');
  assert.ok(!updates.some((u) => u._id === 'u1' || u._id === 'u2'));
  // The patch is module-owned only.
  assert.equal(updates[0].name, undefined);
  assert.equal(updates[0].system.magicalBonus, undefined);
  assert.equal(updates[0].system.activities, undefined);

  // Unknown actors' items are never touched by the mock merge.
  assert.equal(items[0].system.proficient, 0);
  assert.equal(items[1].system.proficient, 1);
});

test('syncActorItems: moving to an ambiguous tier clears native damage/range idempotently and leaves activities alone', async () => {
  const items = [
    {
      _id: 's1',
      flags: { [FLAGS_KEY]: { catalogId: 'test/ranged-then-ambiguous' } },
      system: {
        proficient: 0,
        damage: { base: { number: 1, denomination: 8, bonus: '2', types: ['piercing'] } },
        range: { value: 20, long: 60, units: 'ft' },
        activities: { attack: { id: 'a' } },
      },
    },
  ];
  const actor = makeActor(items);
  const training = { items: { 'test/ranged-then-ambiguous': 'proficient' } };

  const first = await syncActorItems(actor, [rangedThenAmbiguous], training);
  assert.equal(first.length, 1);
  assert.deepEqual(first[0].system.damage.base, {
    number: 0,
    denomination: 0,
    bonus: '2',
    types: ['piercing'],
  });
  assert.deepEqual(first[0].system.range, { value: null, long: null, units: 'ft' });
  assert.equal(first[0].system.proficient, 1);
  // Module-owned patch never carries activities; they survive the merge.
  assert.equal(first[0].system.activities, undefined);
  assert.deepEqual(items[0].system.activities, { attack: { id: 'a' } });

  // The cleared state is idempotent: a second run writes nothing, but the last
  // embedded-document update still reflects the single clearing write.
  const second = await syncActorItems(actor, [rangedThenAmbiguous], training);
  assert.deepEqual(second, []);
  assert.equal(actor.__lastUpdates().length, 1);
});

test('syncActorItems: moving to a sole melee tier clears native range idempotently', async () => {
  const items = [
    {
      _id: 's2',
      flags: { [FLAGS_KEY]: { catalogId: 'test/ranged-then-melee' } },
      system: {
        proficient: 0,
        damage: { base: { number: 1, denomination: 6, bonus: '2', types: ['piercing'] } },
        range: { value: 20, long: 60, units: 'ft' },
      },
    },
  ];
  const actor = makeActor(items);
  const training = { items: { 'test/ranged-then-melee': 'proficient' } };

  const first = await syncActorItems(actor, [rangedThenMelee], training);
  assert.equal(first.length, 1);
  assert.deepEqual(first[0].system.damage.base, {
    number: 1,
    denomination: 8,
    bonus: '2',
    types: ['piercing'],
  });
  assert.deepEqual(first[0].system.range, { value: null, long: null, units: 'ft' });
  assert.equal(first[0].system.proficient, 1);

  const second = await syncActorItems(actor, [rangedThenMelee], training);
  assert.deepEqual(second, []);
});

test('syncActorItems: preserves a nonzero user price and native mastery while migrating zero weight', async () => {
  const items = [
    {
      _id: 'm1',
      flags: { [FLAGS_KEY]: { catalogId: 'firearms/bolt-action-rifle' } },
      system: {
        proficient: 0,
        mastery: 2,
        weight: { value: 0, units: 'lb' },
        price: { value: 50, denomination: 'gp' },
      },
    },
  ];
  const actor = makeActor(items);
  const training = { groups: { Firearms: 'proficient' } };

  const first = await syncActorItems(actor, catalog.equipment, training);
  assert.equal(first.length, 1);
  // The patch never sets mastery, never overwrites the nonzero price, and
  // migrates the zero weight from the parsed source.
  assert.equal(first[0].system.mastery, undefined);
  assert.equal(first[0].system.price, undefined);
  assert.deepEqual(first[0].system.weight, { value: 12, units: 'lb' });
  assert.equal(items[0].system.mastery, 2);
  assert.deepEqual(items[0].system.price, { value: 50, denomination: 'gp' });
  assert.deepEqual(items[0].system.weight, { value: 12, units: 'lb' });

  // Idempotent: the migrated weight is never rewritten, and nothing writes again.
  const second = await syncActorItems(actor, catalog.equipment, training);
  assert.deepEqual(second, []);
});

test('syncActorItems: a legacy natural weapon with matching system fields gains flag metadata on first sync only', async () => {
  const level = 'proficient';
  const clawProps = propsOf(claw, level);
  const items = [
    {
      _id: 'nw1',
      // An old-release flag block: catalogId only, no module-owned metadata.
      flags: { [FLAGS_KEY]: { catalogId: 'natural-weapons/claw' } },
      // Native system fields already match the tier, so no system diff exists.
      system: { proficient: 1, type: { value: 'natural' }, properties: clawProps },
    },
  ];
  const actor = makeActor(items);
  const training = { groups: { 'Natural Weapons': level } };

  const first = await syncActorItems(actor, catalog.equipment, training);
  assert.equal(first.length, 1);
  const flags = first[0].flags[FLAGS_KEY];
  assert.equal(flags.activeTier, level);
  assert.deepEqual(flags.activeProperties, tierProperties(claw, level));
  assert.equal(flags.expertPerk, claw.expertPerk);
  assert.equal(flags.catalogId, 'natural-weapons/claw');
  // Only the flag metadata was added; no system field was rewritten.
  assert.deepEqual(items[0].system, {
    proficient: 1,
    type: { value: 'natural' },
    properties: clawProps,
  });

  const second = await syncActorItems(actor, catalog.equipment, training);
  assert.deepEqual(second, []);
});

test('syncActorItems: a legacy rifle with matching system fields gains activeProperties and the expert perk', async () => {
  const level = 'expert';
  const target = fullySyncedState(boltActionRifle, level);
  const items = [
    {
      _id: 'lr1',
      // An old-release flag block: catalogId only, no module-owned metadata.
      flags: { [FLAGS_KEY]: { catalogId: 'firearms/bolt-action-rifle' } },
      system: target.system,
    },
  ];
  const actor = makeActor(items);
  const training = { items: { 'firearms/bolt-action-rifle': level } };

  const first = await syncActorItems(actor, catalog.equipment, training);
  assert.equal(first.length, 1);
  const flags = first[0].flags[FLAGS_KEY];
  assert.equal(flags.activeTier, level);
  assert.deepEqual(flags.activeProperties, tierProperties(boltActionRifle, level));
  assert.equal(flags.expertPerk, boltActionRifle.expertPerk);
  assert.ok(flags.activeProperties.some((p) => p.key === 'rme-disarm'));

  const second = await syncActorItems(actor, catalog.equipment, training);
  assert.deepEqual(second, []);
});

// ---------------------------------------------------------------------------
// reloadActivityData
// ---------------------------------------------------------------------------

test('reloadActivityData: a non-magazine weapon returns no reload activities', () => {
  assert.deepEqual(reloadActivityData(battleAxe, 'proficient'), {});
  assert.deepEqual(reloadActivityData(shortbow, 'expert'), {});
  assert.deepEqual(reloadActivityData(claw, 'proficient'), {});
});

test('reloadActivityData: a magazine rifle at untrained exposes only the full reload', () => {
  const reload = reloadActivityData(boltActionRifle, 'untrained');
  assert.deepEqual(Object.keys(reload), [RELOAD_FULL_ID]);
  const full = reload[RELOAD_FULL_ID];
  assert.equal(full._id, RELOAD_FULL_ID);
  assert.equal(full.type, 'utility');
  assert.equal(full.sort, 1);
  assert.equal(full.name, 'RME Reload (Action)');
  assert.deepEqual(full.activation, {
    type: 'action',
    value: 1,
    condition: 'Reload (Action)',
    override: false,
  });
  assert.deepEqual(full.consumption, {
    targets: [],
    scaling: { allowed: false, max: '' },
    spellSlot: false,
  });
  assert.deepEqual(full.roll, { formula: '', name: '', prompt: false, visible: false });
  assert.deepEqual(full.flags, { [FLAGS_KEY]: { reloadOptionId: 'action-full' } });
  assert.equal(reload[RELOAD_FAST_ID], undefined);
});

test('reloadActivityData: an expert rifle adds the single-cartridge object-interaction reload', () => {
  const reload = reloadActivityData(boltActionRifle, 'expert');
  assert.deepEqual(Object.keys(reload).sort(), [RELOAD_FULL_ID, RELOAD_FAST_ID].sort());
  const fast = reload[RELOAD_FAST_ID];
  assert.equal(fast.sort, 2);
  assert.equal(fast.name, 'RME Reload (Object Interaction (single cartridge))');
  assert.equal(fast.activation.type, 'special');
  assert.equal(fast.activation.condition, 'Reload (Object Interaction (single cartridge))');
  assert.equal(fast.flags[FLAGS_KEY].reloadOptionId, 'special-single');
});

test('reloadActivityData: an expert break-action revolver adds a bonus-action reload', () => {
  const reload = reloadActivityData(breakActionRevolver, 'expert');
  assert.deepEqual(Object.keys(reload).sort(), [RELOAD_FULL_ID, RELOAD_FAST_ID].sort());
  const fast = reload[RELOAD_FAST_ID];
  assert.equal(fast.activation.type, 'bonus');
  assert.equal(fast.activation.condition, 'Reload (Bonus)');
  assert.equal(fast.flags[FLAGS_KEY].reloadOptionId, 'bonus-full');
});

test('reloadActivityData: repeating crossbow and spinner expose a free reload at every tier', () => {
  for (const level of ['untrained', 'proficient', 'expert']) {
    for (const weapon of [repeatingCrossbow, spinner]) {
      const reload = reloadActivityData(weapon, level);
      assert.deepEqual(Object.keys(reload).sort(), [RELOAD_FULL_ID, RELOAD_FAST_ID].sort());
      const fast = reload[RELOAD_FAST_ID];
      assert.equal(fast.activation.type, 'special');
      assert.equal(fast.activation.condition, 'Reload (Free)');
      assert.equal(fast.flags[FLAGS_KEY].reloadOptionId, 'special-full');
    }
  }
});

// ---------------------------------------------------------------------------
// syncActorItems - reload activities
// ---------------------------------------------------------------------------

test('syncActorItems: moving off an expert tier removes a stale fast reload idempotently', async () => {
  const proficient = fullySyncedState(boltActionRifle, 'proficient');
  const expert = makeItemData(boltActionRifle, 'expert');
  const items = [
    {
      _id: 'dg1',
      // Module flag metadata is already at proficient, but the activities still
      // carry the expert fast reload from a prior synced state.
      flags: proficient.flags,
      system: { ...proficient.system, activities: expert.system.activities },
    },
  ];
  const actor = makeActor(items);
  const training = { items: { 'firearms/bolt-action-rifle': 'proficient' } };

  const first = await syncActorItems(actor, catalog.equipment, training);
  assert.equal(first.length, 1);
  const activities = items[0].system.activities;
  assert.equal(activities[RELOAD_FAST_ID], undefined);
  assert.ok(activities[RELOAD_FULL_ID]);
  assert.equal(activities[ATTACK_ID].name, 'Attack');

  // The fast reload is gone, so no further update is issued.
  const second = await syncActorItems(actor, catalog.equipment, training);
  assert.deepEqual(second, []);
});

test('syncActorItems: a fully synced magazine weapon stays idempotent', async () => {
  const rifle = fullySyncedState(boltActionRifle, 'expert');
  const items = [{ _id: 'id1', flags: rifle.flags, system: rifle.system }];
  const actor = makeActor(items);
  const training = { items: { 'firearms/bolt-action-rifle': 'expert' } };
  const updates = await syncActorItems(actor, catalog.equipment, training);
  assert.deepEqual(updates, []);
  assert.equal(actor.__lastUpdates(), null);
});

test('syncActorItems: preserves a user activity id while adding reload activities', async () => {
  const base = fullySyncedState(boltActionRifle, 'proficient');
  const userActivity = { _id: 'userActivity', type: 'utility', name: 'User Action', sort: 5 };
  const items = [
    {
      _id: 'u1',
      flags: { [FLAGS_KEY]: { catalogId: 'firearms/bolt-action-rifle' } },
      system: {
        ...base.system,
        activities: { userActivity },
      },
    },
  ];
  const actor = makeActor(items);
  const training = { items: { 'firearms/bolt-action-rifle': 'proficient' } };

  const first = await syncActorItems(actor, catalog.equipment, training);
  assert.equal(first.length, 1);
  const activities = items[0].system.activities;
  // The user-defined activity is preserved, and because no attack exists the
  // module-owned default attack and the full reload are added.
  assert.deepEqual(activities.userActivity, userActivity);
  assert.ok(activities[RELOAD_FULL_ID]);
  assert.equal(activities[RELOAD_FAST_ID], undefined);
  assert.equal(activities[ATTACK_ID].type, 'attack');
  assert.deepEqual(
    Object.keys(activities).sort(),
    ['userActivity', ATTACK_ID, RELOAD_FULL_ID].sort()
  );
});

test('syncActorItems: a legacy rifle with no activities gains the module attack and both reloads, idempotently', async () => {
  // A legacy bolt-action rifle that carries no activities at all (e.g. an item
  // authored before the module created reload/attack activities) must, on first
  // sync, receive the explicit native attack plus the two reload activities.
  const items = [
    {
      _id: 'legacy1',
      flags: { [FLAGS_KEY]: { catalogId: 'firearms/bolt-action-rifle' } },
      system: { proficient: 0, weight: { value: 12, units: 'lb' }, price: { value: 1000, denomination: 'gp' } },
    },
  ];
  const actor = makeActor(items);
  const training = { items: { 'firearms/bolt-action-rifle': 'expert' } };

  const first = await syncActorItems(actor, catalog.equipment, training);
  assert.equal(first.length, 1);
  const activities = items[0].system.activities;
  assert.ok(activities[ATTACK_ID], 'expected the module default attack activity');
  assert.equal(activities[ATTACK_ID]._id.length, 16);
  assert.equal(activities[ATTACK_ID].type, 'attack');
  assert.equal(activities[ATTACK_ID].name, 'Attack');
  assert.ok(activities[RELOAD_FULL_ID], 'expected the full reload activity');
  assert.ok(activities[RELOAD_FAST_ID], 'expected the fast reload activity');
  assert.deepEqual(
    Object.keys(activities).sort(),
    [ATTACK_ID, RELOAD_FULL_ID, RELOAD_FAST_ID].sort()
  );

  // After the first sync the item is fully synced; a second run writes nothing.
  const second = await syncActorItems(actor, catalog.equipment, training);
  assert.deepEqual(second, []);
  assert.equal(actor.__lastUpdates().length, 1);
});

test('syncActorItems: an actor with a user attack keeps only that attack and is not overridden', async () => {
  const userAttack = { _id: 'userAtk', type: 'attack', name: 'User Attack', sort: 0 };
  const items = [
    {
      _id: 'ua1',
      flags: { [FLAGS_KEY]: { catalogId: 'firearms/bolt-action-rifle' } },
      system: {
        proficient: 1,
        activities: { userAtk: userAttack },
      },
    },
  ];
  const actor = makeActor(items);
  const training = { items: { 'firearms/bolt-action-rifle': 'proficient' } };

  const first = await syncActorItems(actor, catalog.equipment, training);
  assert.equal(first.length, 1);
  const activities = items[0].system.activities;
  // The user attack is the only attack; the module default is never added on top.
  assert.deepEqual(activities.userAtk, userAttack);
  assert.equal(activities[ATTACK_ID], undefined);
  assert.ok(activities[RELOAD_FULL_ID], 'expected the full reload activity');
  assert.deepEqual(
    Object.keys(activities).sort(),
    ['userAtk', RELOAD_FULL_ID].sort()
  );

  // Idempotent: the user attack is never replaced and nothing writes again.
  const second = await syncActorItems(actor, catalog.equipment, training);
  assert.deepEqual(second, []);
});

test('itemProfilePatch: detects a user attack in a live Map and does not add the module default', () => {
  const userAttack = { _id: 'userAtk', type: 'attack', name: 'User Attack', sort: 0 };
  const item = {
    _id: 'map-atk-1',
    system: {
      proficient: 1,
      activities: new Map([['userAtk', userAttack]]),
    },
  };
  const patch = itemProfilePatch(item, boltActionRifle, 'proficient');
  // The Map exposes a user attack, so the module default attack is not written.
  assert.equal(patch.system[`activities.${ATTACK_ID}`], undefined);
  // The full reload is still written through its granular dotted path.
  assert.ok(patch.system[`activities.${RELOAD_FULL_ID}`]);
  // No stale fast reload exists, so no deletion operator is written.
  assert.equal(patch.system[`activities.-=${RELOAD_FAST_ID}`], undefined);
});

test('syncActorItems: a magazine weapon with matching reload activities in a live Map stays idempotent', async () => {
  const rifle = fullySyncedState(boltActionRifle, 'expert');
  const items = [
    {
      _id: 'map-synced-1',
      flags: rifle.flags,
      system: {
        ...rifle.system,
        // Live MappingField/Collection: activities keyed by id in a Map-like.
        activities: activitiesMap(rifle.system.activities),
      },
    },
  ];
  const actor = makeActor(items);
  const training = { items: { 'firearms/bolt-action-rifle': 'expert' } };

  const updates = await syncActorItems(actor, catalog.equipment, training);
  assert.deepEqual(updates, []);
  assert.equal(actor.__lastUpdates(), null);
});

test('syncActorItems: detects a user attack in a live Map and never adds the module default attack', async () => {
  const userAttack = { _id: 'userAtk', type: 'attack', name: 'User Attack', sort: 0 };
  const items = [
    {
      _id: 'map-atk-2',
      flags: { [FLAGS_KEY]: { catalogId: 'firearms/bolt-action-rifle' } },
      system: {
        proficient: 1,
        activities: new Map([['userAtk', userAttack]]),
      },
    },
  ];
  const actor = makeActor(items);
  const training = { items: { 'firearms/bolt-action-rifle': 'proficient' } };

  const first = await syncActorItems(actor, catalog.equipment, training);
  assert.equal(first.length, 1);
  const activities = items[0].system.activities;
  assert.ok(activities instanceof Map);
  // The user attack is the only attack; the module default is never added on top.
  assert.deepEqual(activities.get('userAtk'), userAttack);
  assert.equal(activities.get(ATTACK_ID), undefined);
  assert.ok(activities.get(RELOAD_FULL_ID), 'expected the full reload activity');
  assert.equal(activities.get(RELOAD_FAST_ID), undefined);

  // Idempotent: the user attack is never replaced and nothing writes again.
  const second = await syncActorItems(actor, catalog.equipment, training);
  assert.deepEqual(second, []);
});
