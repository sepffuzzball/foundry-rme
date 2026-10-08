import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  ammoEffect,
  attackBonusFor,
  damageAdditionsFor,
  riderFor,
  effectSummary,
} from '../src/ammo-effects.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ammoCatalog = JSON.parse(
  readFileSync(join(__dirname, '..', 'data', 'ammunition.json'), 'utf8')
);

// ---------------------------------------------------------------------------
// Coverage of all 25 stacks
// ---------------------------------------------------------------------------

test('ammo-effects: the catalog carries all 25 approved ammunition stacks', () => {
  assert.equal(ammoCatalog.ammunition.length, 25);
});

test('ammo-effects: every stack id resolves to an effect, an integer bonus, a damage array, a rider, and a summary', () => {
  for (const ammo of ammoCatalog.ammunition) {
    const id = ammo.id;
    assert.ok(ammoEffect(id, ammoCatalog), `${id} must expose an effect`);
    assert.equal(typeof ammoEffect(id, ammoCatalog), 'object', `${id} effect must be an object`);

    const bonus = attackBonusFor(id, ammoCatalog);
    assert.equal(Number.isInteger(bonus), true, `${id} attack bonus must be an integer`);
    assert.ok(bonus === 0 || bonus === 1 || bonus === 2, `${id} bonus must be 0/1/2`);

    const additions = damageAdditionsFor(id, ammoCatalog);
    assert.equal(Array.isArray(additions), true, `${id} damage additions must be an array`);
    for (const addition of additions) {
      assert.equal(typeof addition.formula, 'string', `${id} addition formula must be a string`);
      assert.ok(
        addition.type === null || typeof addition.type === 'string',
        `${id} addition type must be null or a string`
      );
    }

    const rider = riderFor(id, ammoCatalog);
    for (const key of ['save', 'condition', 'radiusFeet', 'duration', 'halfOnSave', 'cone', 'fewerBaseDie']) {
      assert.ok(key in rider, `${id} rider must carry ${key}`);
    }

    const summary = effectSummary(id, ammoCatalog);
    assert.equal(typeof summary, 'string', `${id} summary must be a string`);
    assert.ok(summary.length > 0, `${id} summary must not be empty`);
  }
});

// ---------------------------------------------------------------------------
// ammoEffect
// ---------------------------------------------------------------------------

test('ammoEffect returns the declarative effect object for a known ammo id', () => {
  assert.deepEqual(ammoEffect('crossbow/walloping-bolts', ammoCatalog), {
    text: 'On a hit, the target must succeed on a Strength saving throw (DC 10) or be knocked prone.',
    tags: ['knockback'],
    trigger: 'on-hit',
    save: { ability: 'str', dc: 10 },
    condition: 'prone',
  });
});

test("ammoEffect returns null for the 'javelin' sentinel and for unknown ids", () => {
  assert.equal(ammoEffect('javelin', ammoCatalog), null);
  assert.equal(ammoEffect('crossbow/does-not-exist', ammoCatalog), null);
});

test('ammoEffect never mutates the catalog and accepts the array form of the catalog', () => {
  const list = ammoCatalog.ammunition;
  const snapshot = JSON.stringify(list);
  assert.deepEqual(ammoEffect('arrow/fire-arrows', list), ammoEffect('arrow/fire-arrows', ammoCatalog));
  assert.equal(JSON.stringify(list), snapshot, 'passing the array must not mutate it');
});

// ---------------------------------------------------------------------------
// attackBonusFor
// ---------------------------------------------------------------------------

test('attackBonusFor maps +1 and +2 ammunition to 1 and 2, and everything else to 0', () => {
  assert.equal(attackBonusFor('crossbow/plus-1-bolts', ammoCatalog), 1);
  assert.equal(attackBonusFor('arrow/plus-1-arrows', ammoCatalog), 1);
  assert.equal(attackBonusFor('rifle/match-grade-rifle-cartridge', ammoCatalog), 1);
  assert.equal(attackBonusFor('pistol/match-grade-pistol-cartridge', ammoCatalog), 1);
  assert.equal(attackBonusFor('rifle/masterwork-rifle-cartridge', ammoCatalog), 2);
  assert.equal(attackBonusFor('pistol/masterwork-pistol-cartridge', ammoCatalog), 2);

  assert.equal(attackBonusFor('crossbow/bolts', ammoCatalog), 0);
  assert.equal(attackBonusFor('arrow/fire-arrows', ammoCatalog), 0);
  assert.equal(attackBonusFor('shotgun/buckshot', ammoCatalog), 0);
  assert.equal(attackBonusFor('mpl/mpl-grenade', ammoCatalog), 0);
  assert.equal(attackBonusFor('javelin', ammoCatalog), 0);
});

// ---------------------------------------------------------------------------
// damageAdditionsFor
// ---------------------------------------------------------------------------

test('damageAdditionsFor: +1/+2 ammunition grants only a flat null-typed bonus to base damage', () => {
  const plus1 = damageAdditionsFor('crossbow/plus-1-bolts', ammoCatalog);
  assert.ok(Array.isArray(plus1));
  assert.equal(plus1.length, 1);
  assert.deepEqual(plus1[0], { formula: '+1', type: null });

  const plus2 = damageAdditionsFor('rifle/masterwork-rifle-cartridge', ammoCatalog);
  assert.deepEqual(plus2, [{ formula: '+2', type: null }]);
});

test('damageAdditionsFor: elemental arrows add a typed 1d4 extra damage roll', () => {
  assert.deepEqual(damageAdditionsFor('arrow/fire-arrows', ammoCatalog), [
    { formula: '1d4', type: 'fire' },
  ]);
  assert.deepEqual(damageAdditionsFor('arrow/ice-arrows', ammoCatalog), [
    { formula: '1d4', type: 'cold' },
  ]);
  assert.deepEqual(damageAdditionsFor('arrow/poison-arrows', ammoCatalog), [
    { formula: '1d4', type: 'poison' },
  ]);
  assert.deepEqual(damageAdditionsFor('arrow/shock-arrows', ammoCatalog), [
    { formula: '1d4', type: 'lightning' },
  ]);
  assert.deepEqual(damageAdditionsFor('arrow/acid-arrows', ammoCatalog), [
    { formula: '1d4', type: 'acid' },
  ]);
  assert.deepEqual(damageAdditionsFor('arrow/thunder-arrows', ammoCatalog), [
    { formula: '1d4', type: 'thunder' },
  ]);
});

test('damageAdditionsFor: MPL grenade and incendiary yield a typed separate 2d6 roll', () => {
  assert.deepEqual(damageAdditionsFor('mpl/mpl-grenade', ammoCatalog), [
    { formula: '2d6', type: 'bludgeoning' },
  ]);
  assert.deepEqual(damageAdditionsFor('mpl/mpl-incendiary', ammoCatalog), [
    { formula: '2d6', type: 'fire' },
  ]);
});

test('damageAdditionsFor: no extra damage for base ammo, riders-only ammo, or buckshot', () => {
  assert.deepEqual(damageAdditionsFor('crossbow/bolts', ammoCatalog), []);
  assert.deepEqual(damageAdditionsFor('spinner/bladed-disks', ammoCatalog), []);
  assert.deepEqual(damageAdditionsFor('arrow/arrows', ammoCatalog), []);
  assert.deepEqual(damageAdditionsFor('crossbow/walloping-bolts', ammoCatalog), []);
  assert.deepEqual(damageAdditionsFor('crossbow/goading-bolts', ammoCatalog), []);
  assert.deepEqual(damageAdditionsFor('shotgun/buckshot', ammoCatalog), []);
  assert.deepEqual(damageAdditionsFor('mpl/mpl-smoke', ammoCatalog), []);
  assert.deepEqual(damageAdditionsFor('mpl/mpl-flashbang', ammoCatalog), []);
  assert.deepEqual(damageAdditionsFor('javelin', ammoCatalog), []);
});

// ---------------------------------------------------------------------------
// riderFor
// ---------------------------------------------------------------------------

test('riderFor: Goading Bolts carries a Wisdom save at DC 13 for the goaded condition', () => {
  const rider = riderFor('crossbow/goading-bolts', ammoCatalog);
  assert.deepEqual(rider.save, { ability: 'wis', dc: 13 });
  assert.equal(rider.condition, 'goaded');
  assert.equal(rider.duration, "until end of target's next turn");
  assert.equal(rider.halfOnSave, false);
});

test('riderFor: Walloping Bolts carries a Strength save at DC 10 for the prone condition', () => {
  const rider = riderFor('crossbow/walloping-bolts', ammoCatalog);
  assert.deepEqual(rider.save, { ability: 'str', dc: 10 });
  assert.equal(rider.condition, 'prone');
  assert.equal(rider.halfOnSave, false);
});

test('riderFor: poison damage is not surfaced as a poison condition', () => {
  const rider = riderFor('arrow/poison-arrows', ammoCatalog);
  assert.equal(rider.condition, null);
  assert.equal(rider.save, null);
  // The poison is a damage type, never a status condition.
  assert.notEqual(rider.condition, 'poisoned');
  assert.deepEqual(damageAdditionsFor('arrow/poison-arrows', ammoCatalog), [
    { formula: '1d4', type: 'poison' },
  ]);
});

test('riderFor: buckshot is a 15-foot cone spread with one fewer base damage die and no extra damage', () => {
  const rider = riderFor('shotgun/buckshot', ammoCatalog);
  assert.equal(rider.radiusFeet, 15);
  assert.equal(rider.cone, true);
  assert.equal(rider.fewerBaseDie, true);
  assert.equal(rider.halfOnSave, false);
  assert.deepEqual(damageAdditionsFor('shotgun/buckshot', ammoCatalog), []);
});

test('riderFor: MPL sizes, durations, and save DCs are drawn from the catalog', () => {
  const grenade = riderFor('mpl/mpl-grenade', ammoCatalog);
  assert.equal(grenade.radiusFeet, 10);
  assert.deepEqual(grenade.save, { ability: 'dex', dc: 13 });
  assert.equal(grenade.halfOnSave, true);

  const incendiary = riderFor('mpl/mpl-incendiary', ammoCatalog);
  assert.equal(incendiary.radiusFeet, 10);
  assert.deepEqual(incendiary.save, { ability: 'dex', dc: 13 });
  assert.equal(incendiary.halfOnSave, true);

  const smoke = riderFor('mpl/mpl-smoke', ammoCatalog);
  assert.equal(smoke.radiusFeet, 20);
  assert.equal(smoke.condition, 'heavily-obscured');
  assert.equal(smoke.duration, '1 minute');
  assert.equal(smoke.halfOnSave, false);

  const flashbang = riderFor('mpl/mpl-flashbang', ammoCatalog);
  assert.equal(flashbang.radiusFeet, 10);
  assert.deepEqual(flashbang.save, { ability: 'con', dc: 13 });
  assert.equal(flashbang.condition, 'blinded');
  assert.equal(flashbang.duration, "until end of target's next turn");
  assert.equal(flashbang.halfOnSave, false);
});

test('riderFor: base ammunition carries no rider descriptors', () => {
  const rider = riderFor('crossbow/bolts', ammoCatalog);
  assert.deepEqual(rider, {
    save: null,
    condition: null,
    radiusFeet: null,
    duration: null,
    halfOnSave: false,
    cone: false,
    fewerBaseDie: false,
  });
});

// ---------------------------------------------------------------------------
// effectSummary
// ---------------------------------------------------------------------------

test('effectSummary returns the catalog effect text for chat display', () => {
  assert.equal(
    effectSummary('crossbow/plus-1-bolts', ammoCatalog),
    'Grants a +1 bonus to attack and damage rolls.'
  );
  assert.equal(
    effectSummary('arrow/fire-arrows', ammoCatalog),
    'On a hit, deals an extra 1d4 fire damage.'
  );
  assert.equal(
    effectSummary('shotgun/buckshot', ammoCatalog),
    'Fires in a 15-foot cone. Uses one fewer base damage die.'
  );
});

test('effectSummary HTML-escapes the returning plain text', () => {
  const syntheticCatalog = {
    ammunition: [
      {
        id: 'test/escaped',
        effect: { text: '<b>Bold & "quoted"</b>' },
      },
    ],
  };
  assert.equal(
    effectSummary('test/escaped', syntheticCatalog),
    '&lt;b&gt;Bold &amp; &quot;quoted&quot;&lt;/b&gt;'
  );
});

test('effectSummary returns an empty string for an unknown id', () => {
  assert.equal(effectSummary('javelin', ammoCatalog), '');
  assert.equal(effectSummary('crossbow/does-not-exist', ammoCatalog), '');
});

// ---------------------------------------------------------------------------
// No input mutation
// ---------------------------------------------------------------------------

test('ammo-effects functions never mutate the catalog input', () => {
  const catalog = JSON.parse(
    readFileSync(join(__dirname, '..', 'data', 'ammunition.json'), 'utf8')
  );
  const before = JSON.parse(JSON.stringify(catalog));

  for (const ammo of catalog.ammunition) {
    ammoEffect(ammo.id, catalog);
    attackBonusFor(ammo.id, catalog);
    damageAdditionsFor(ammo.id, catalog);
    riderFor(ammo.id, catalog);
    effectSummary(ammo.id, catalog);
  }
  ammoEffect('javelin', catalog);
  effectSummary('javelin', catalog);

  assert.deepEqual(catalog, before);
});
