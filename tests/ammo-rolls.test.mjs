import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import {
  handleAmmoAttackRoll,
  handleAmmoDamageConfig,
  ammoEffectDetails,
} from '../src/ammo-rolls.mjs';
import { riderFor } from '../src/ammo-effects.mjs';

const catalog = JSON.parse(
  await readFile(new URL('../data/catalog.json', import.meta.url), 'utf8')
);
const equipment = catalog.equipment;
const ammoCatalog = JSON.parse(
  await readFile(new URL('../data/ammunition.json', import.meta.url), 'utf8')
);

const RIFLE = 'firearms/bolt-action-rifle';
const SHORTBOW = 'bows/shortbow';
const PORTABLE_BALLISTA = 'crossbows/portable-ballista';
const SHOTGUN = 'firearms/double-barrelled-shotgun';
const MPL = 'firearms/multi-purpose-launcher';

// ---------------------------------------------------------------------------
// Foundry-fake helpers
// ---------------------------------------------------------------------------

const ORIGINAL_FOUNDRY = globalThis.foundry;
const ORIGINAL_GAME = globalThis.game;

afterEach(() => {
  globalThis.foundry = ORIGINAL_FOUNDRY;
  globalThis.game = ORIGINAL_GAME;
});

// The real Foundry term classes take {operator} / {number, options}; these
// fakes mirror that constructor shape so the guarded `new` path is exercised.
class FakeOperatorTerm {
  constructor(options) {
    this.term = 'OperatorTerm';
    this.operator = options.operator;
  }
}
class FakeNumericTerm {
  constructor(options) {
    this.term = 'NumericTerm';
    this.number = options.number;
    this.options = options.options;
  }
}

function installFoundryTerms() {
  globalThis.foundry = {
    dice: {
      terms: { OperatorTerm: FakeOperatorTerm, NumericTerm: FakeNumericTerm },
    },
  };
}

function makeRoll({ terms = [], evaluated = false, options = {}, parts = null } = {}) {
  const roll = {
    terms,
    evaluated,
    options: { ...options },
    resetCalls: 0,
    resetFormula() {
      this.resetCalls += 1;
    },
  };
  if (parts) roll.parts = parts;
  return roll;
}

// ---------------------------------------------------------------------------
// Actor / item fixtures
// ---------------------------------------------------------------------------

function setPath(obj, path, value) {
  const parts = path.split('.');
  let target = obj;
  for (let i = 0; i < parts.length - 1; i += 1) {
    const key = parts[i];
    if (!target[key] || typeof target[key] !== 'object') target[key] = {};
    target = target[key];
  }
  target[parts[parts.length - 1]] = value;
}

function makeAmmoActor(items, flags = {}, isOwner = true) {
  const list = items.map((item) => structuredClone(item));
  const byId = new Map(list.map((i) => [i._id ?? i.id, i]));
  list.get = (id) => byId.get(id) ?? null;
  list.has = (id) => byId.has(id);
  const state = {};
  for (const [scope, values] of Object.entries(flags)) state[scope] = { ...values };
  const actor = {
    id: 'actor1',
    documentName: 'Actor',
    isOwner,
    items: list,
    getFlag(scope, key) { return state[scope]?.[key]; },
  };
  return { actor, byId, list };
}

function weaponItem(id, catalogId, ammoState = null) {
  const flags = { 'foundry-rme': { catalogId } };
  if (ammoState) flags['foundry-rme'].ammunition = { ...ammoState };
  return { _id: id, id, type: 'weapon', name: id, flags, system: { proficient: 0 } };
}

function ammoItem(id, { family, ammoId, qty = 20, name = null, type = 'consumable' }) {
  return {
    _id: id,
    id,
    name: name || id,
    type,
    quantity: qty,
    system: { quantity: qty, type: { value: type === 'consumable' ? 'ammo' : type, subtype: `rme-${family}` } },
    flags: { 'foundry-rme': { family, ammoId } },
  };
}

function attackActivity(actor, item) {
  return { type: 'attack', actor, item, flags: {}, id: 'act1' };
}

function attackConfig(actor, weapon, roll, { subjectType = 'attack' } = {}) {
  return { subject: { ...attackActivity(actor, weapon), type: subjectType } };
}

function weaponSubject(catalogId) {
  const { actor } = makeAmmoActor([weaponItem('w1', catalogId)]);
  return attackActivity(actor, actor.items.get('w1'));
}

// ---------------------------------------------------------------------------
// ammoEffectDetails
// ---------------------------------------------------------------------------

test('ammoEffectDetails: describes an approved rider for display, not automation', () => {
  const walloping = ammoEffectDetails('crossbow/walloping-bolts', ammoCatalog);
  assert.match(walloping, /Strength saving throw/);
  assert.match(walloping, /DC 10/);
  assert.match(walloping, /prone/);

  const buckshot = ammoEffectDetails('shotgun/buckshot', ammoCatalog);
  assert.match(buckshot, /15-foot cone/);
  assert.match(buckshot, /one fewer base damage die/);

  const mpl = ammoEffectDetails('mpl/mpl-grenade', ammoCatalog);
  assert.match(mpl, /10-foot radius/);
  assert.match(mpl, /Dexterity saving throw/);
  assert.match(mpl, /Half damage on a successful save/);
});

test('ammoEffectDetails: poison is damage only, never a condition', () => {
  const detail = ammoEffectDetails('arrow/poison-arrows', ammoCatalog);
  assert.doesNotMatch(detail, /poisoned/i);
  assert.doesNotMatch(detail, /saving throw/);
  assert.match(detail, /poison/);

  const rider = riderFor('arrow/poison-arrows', ammoCatalog);
  assert.equal(rider.condition, null);
  assert.equal(rider.save, null);
});

test('ammoEffectDetails: base ammo returns its effect text and unknown id is empty', () => {
  const base = ammoEffectDetails('crossbow/bolts', ammoCatalog);
  assert.equal(typeof base, 'string');
  assert.ok(base.length > 0);
  assert.equal(ammoEffectDetails('javelin', ammoCatalog), '');
  assert.equal(ammoEffectDetails('crossbow/does-not-exist', ammoCatalog), '');
});

// ---------------------------------------------------------------------------
// handleAmmoAttackRoll
// ---------------------------------------------------------------------------

test('handleAmmoAttackRoll: appends +1 operator/numeric terms and calls resetFormula', () => {
  installFoundryTerms();
  const { actor } = makeAmmoActor([
    weaponItem('w1', RIFLE, { reserveItemId: 'a1', loaded: 4, loadedAmmoId: 'rifle/match-grade-rifle-cartridge' }),
    ammoItem('a1', { family: 'rifle', ammoId: 'rifle/rifle-cartridge' }),
  ]);
  const weapon = actor.items.get('w1');
  const roll = makeRoll({ terms: [], options: { attackMode: 'ranged' } });
  const rolls = [roll];
  const message = { data: { flags: {} } };

  const result = handleAmmoAttackRoll(
    rolls,
    { subject: attackActivity(actor, weapon) },
    {},
    message,
    equipment,
    ammoCatalog
  );

  assert.equal(result.handled, true);
  assert.equal(result.applied, true);
  assert.equal(result.attackBonus, 1);
  assert.equal(roll.terms.length, 2);
  assert.equal(roll.terms[0].term, 'OperatorTerm');
  assert.equal(roll.terms[0].operator, '+');
  assert.equal(roll.terms[1].term, 'NumericTerm');
  assert.equal(roll.terms[1].number, 1);
  assert.deepEqual(roll.terms[1].options, { flavor: 'RME ammunition' });
  assert.equal(roll.resetCalls, 1);
  assert.equal(message.data.flags['foundry-rme'].ammoId, 'rifle/match-grade-rifle-cartridge');
});

test('handleAmmoAttackRoll: provenance uses the loaded ammo when it differs from the reserve', () => {
  installFoundryTerms();
  const { actor } = makeAmmoActor([
    weaponItem('w1', RIFLE, { reserveItemId: 'a1', loaded: 4, loadedAmmoId: 'rifle/masterwork-rifle-cartridge' }),
    ammoItem('a1', { family: 'rifle', ammoId: 'rifle/rifle-cartridge' }),
  ]);
  const roll = makeRoll({ terms: [], options: { attackMode: 'ranged' } });
  const message = { data: { flags: {} } };

  handleAmmoAttackRoll(
    [roll],
    { subject: attackActivity(actor, actor.items.get('w1')) },
    {},
    message,
    equipment,
    ammoCatalog
  );

  assert.equal(message.data.flags['foundry-rme'].ammoId, 'rifle/masterwork-rifle-cartridge');
});

test('handleAmmoAttackRoll: attack flags preserve other message flags', () => {
  installFoundryTerms();
  const { actor } = makeAmmoActor([
    weaponItem('w1', RIFLE, { reserveItemId: 'a1', loaded: 4, loadedAmmoId: 'rifle/match-grade-rifle-cartridge' }),
    ammoItem('a1', { family: 'rifle', ammoId: 'rifle/rifle-cartridge' }),
  ]);
  const roll = makeRoll({ terms: [], options: { attackMode: 'ranged' } });
  const message = {
    data: {
      content: 'hello',
      flags: { otherScope: { x: 1 }, some: 'kept' },
    },
  };

  handleAmmoAttackRoll(
    [roll],
    { subject: attackActivity(actor, actor.items.get('w1')) },
    {},
    message,
    equipment,
    ammoCatalog
  );

  const flags = message.data.flags;
  assert.deepEqual(flags.otherScope, { x: 1 });
  assert.equal(flags.some, 'kept');
  assert.equal(flags['foundry-rme'].ammoId, 'rifle/match-grade-rifle-cartridge');
  assert.ok(flags['foundry-rme'].ammoEffectText.length > 0);
});

test('handleAmmoAttackRoll: never applies the bonus twice and never mutates evaluated rolls', () => {
  installFoundryTerms();
  const { actor } = makeAmmoActor([
    weaponItem('w1', RIFLE, { reserveItemId: 'a1', loaded: 4, loadedAmmoId: 'rifle/match-grade-rifle-cartridge' }),
    ammoItem('a1', { family: 'rifle', ammoId: 'rifle/rifle-cartridge' }),
  ]);
  const roll = makeRoll({ terms: [], options: { attackMode: 'ranged' } });
  const rolls = [roll];
  const message = { data: { flags: {} } };
  const config = { subject: attackActivity(actor, actor.items.get('w1')) };

  handleAmmoAttackRoll(rolls, config, {}, message, equipment, ammoCatalog);
  const lengthAfterFirst = roll.terms.length;
  const firstResetCalls = roll.resetCalls;

  // Second call must not append again (marker on roll.options).
  const second = handleAmmoAttackRoll(rolls, config, {}, message, equipment, ammoCatalog);
  assert.equal(roll.terms.length, lengthAfterFirst);
  assert.equal(roll.resetCalls, firstResetCalls);
  assert.equal(second.applied, false);
  assert.equal(roll.options.rmeAmmoApplied, true);

  // An evaluated roll is never mutated.
  const evaluated = makeRoll({ terms: [], evaluated: true, options: { attackMode: 'ranged' } });
  handleAmmoAttackRoll([evaluated], config, {}, message, equipment, ammoCatalog);
  assert.equal(evaluated.terms.length, 0);
});

test('handleAmmoAttackRoll: reports unavailable via descriptor when foundry.dice.terms is missing', () => {
  // No globalThis.foundry installed.
  const { actor } = makeAmmoActor([
    weaponItem('w1', RIFLE, { reserveItemId: 'a1', loaded: 4, loadedAmmoId: 'rifle/masterwork-rifle-cartridge' }),
    ammoItem('a1', { family: 'rifle', ammoId: 'rifle/rifle-cartridge' }),
  ]);
  const roll = makeRoll({ terms: [], options: { attackMode: 'ranged' } });
  const message = { data: { flags: {} } };

  const result = handleAmmoAttackRoll(
    [roll],
    { subject: attackActivity(actor, actor.items.get('w1')) },
    {},
    message,
    equipment,
    ammoCatalog
  );

  assert.equal(result.handled, true);
  assert.equal(result.applied, false);
  assert.equal(result.reason, 'terms-unavailable');
  assert.equal(roll.terms.length, 0);
  assert.equal(roll.resetCalls, 0);
  // Provenance is still attached even when the terms library is absent.
  assert.equal(message.data.flags['foundry-rme'].ammoId, 'rifle/masterwork-rifle-cartridge');
});

test('handleAmmoAttackRoll: canceled / no-ammo attacks have no effect', () => {
  installFoundryTerms();
  // Empty magazine.
  const { actor } = makeAmmoActor([
    weaponItem('w1', RIFLE, { reserveItemId: 'a1', loaded: 0, loadedAmmoId: 'rifle/match-grade-rifle-cartridge' }),
    ammoItem('a1', { family: 'rifle', ammoId: 'rifle/rifle-cartridge' }),
  ]);
  const roll = makeRoll({ terms: [], options: { attackMode: 'ranged' } });
  const message = { data: { flags: {} } };

  const result = handleAmmoAttackRoll(
    [roll],
    { subject: attackActivity(actor, actor.items.get('w1')) },
    {},
    message,
    equipment,
    ammoCatalog
  );
  assert.equal(result.handled, true);
  assert.equal(result.applied, false);
  assert.equal(result.reason, 'empty');
  assert.equal(roll.terms.length, 0);
});

test('handleAmmoAttackRoll: no cross-item effects for melee, untagged, non-owned, or non-attack', () => {
  installFoundryTerms();
  const { actor } = makeAmmoActor([
    weaponItem('w1', RIFLE, { reserveItemId: 'a1', loaded: 4, loadedAmmoId: 'rifle/match-grade-rifle-cartridge' }),
    ammoItem('a1', { family: 'rifle', ammoId: 'rifle/rifle-cartridge' }),
  ]);
  const weapon = actor.items.get('w1');
  const message = { data: { flags: {} } };

  const assertNoEffect = (config, rolls) => {
    const before = rolls.map((r) => r.terms.length);
    const result = handleAmmoAttackRoll(rolls, config, {}, message, equipment, ammoCatalog);
    assert.equal(result.handled, false, 'expected noise-free skip');
    assert.deepEqual(rolls.map((r) => r.terms.length), before);
  };

  // Melee attack mode.
  assertNoEffect(
    { subject: attackActivity(actor, weapon) },
    [makeRoll({ terms: [], options: { attackMode: 'melee' } })]
  );

  // Non-attack activity.
  assertNoEffect(
    { subject: { ...attackActivity(actor, weapon), type: 'utility' } },
    [makeRoll({ terms: [], options: { attackMode: 'ranged' } })]
  );

  // Non-owned actor.
  assertNoEffect(
    { subject: attackActivity({ ...actor, isOwner: false }, weapon) },
    [makeRoll({ terms: [], options: { attackMode: 'ranged' } })]
  );

  // Untagged weapon.
  assertNoEffect(
    { subject: attackActivity(actor, { ...weapon, flags: {} }) },
    [makeRoll({ terms: [], options: { attackMode: 'ranged' } })]
  );

  // No config.subject.
  assertNoEffect({}, [makeRoll({ terms: [], options: { attackMode: 'ranged' } })]);

  // Unsupported (untagged) weapon id.
  assertNoEffect(
    { subject: attackActivity(actor, weaponItem('x1', 'axes/battle-axe')) },
    [makeRoll({ terms: [], options: { attackMode: 'ranged' } })]
  );
});

test('handleAmmoAttackRoll: direct-consumption bow reads provenance from the reserve stack', () => {
  installFoundryTerms();
  const { actor } = makeAmmoActor([
    weaponItem('w1', SHORTBOW, { reserveItemId: 'a1' }),
    ammoItem('a1', { family: 'arrow', ammoId: 'arrow/fire-arrows' }),
  ]);
  const roll = makeRoll({ terms: [], options: { attackMode: 'ranged' } });
  const message = { data: { flags: {} } };

  const result = handleAmmoAttackRoll(
    [roll],
    { subject: attackActivity(actor, actor.items.get('w1')) },
    {},
    message,
    equipment,
    ammoCatalog
  );

  assert.equal(result.handled, true);
  assert.equal(result.attackBonus, 0);
  assert.equal(message.data.flags['foundry-rme'].ammoId, 'arrow/fire-arrows');
});

test('handleAmmoAttackRoll: Portable Ballista uses the javelin sentinel', () => {
  installFoundryTerms();
  const { actor } = makeAmmoActor([
    weaponItem('w1', PORTABLE_BALLISTA, { reserveItemId: 'j1' }),
    weaponItem('j1', 'axes/battle-axe', null),
  ]);
  // The javelin reserve is a weapon item named "Javelin" with positive qty.
  actor.items.get('j1').name = 'Javelin';
  actor.items.get('j1').type = 'weapon';
  actor.items.get('j1').quantity = 1;
  actor.items.get('j1').system.quantity = 1;
  const roll = makeRoll({ terms: [], options: { attackMode: 'ranged' } });
  const message = { data: { flags: {} } };

  const result = handleAmmoAttackRoll(
    [roll],
    { subject: attackActivity(actor, actor.items.get('w1')) },
    {},
    message,
    equipment,
    ammoCatalog
  );

  assert.equal(result.handled, true);
  // The javelin sentinel is intentionally not a catalog ammo entry.
  assert.equal(message.data.flags['foundry-rme'].ammoId, 'javelin');
});

test('handleAmmoAttackRoll: an ammo id from another family writes no flags/bonus', () => {
  installFoundryTerms();
  const { actor } = makeAmmoActor([
    weaponItem('w1', RIFLE, { reserveItemId: 'a1', loaded: 4, loadedAmmoId: 'arrow/fire-arrows' }),
    ammoItem('a1', { family: 'rifle', ammoId: 'rifle/rifle-cartridge' }),
  ]);
  const roll = makeRoll({ terms: [], options: { attackMode: 'ranged' } });
  const message = { data: { flags: {} } };

  const result = handleAmmoAttackRoll(
    [roll],
    { subject: attackActivity(actor, actor.items.get('w1')) },
    {},
    message,
    equipment,
    ammoCatalog
  );

  // The rifle's magazine holds arrow ammo; it is invalid for the rifle family,
  // so no terms are appended and no provenance flag is written.
  assert.equal(result.handled, true);
  assert.equal(result.applied, false);
  assert.equal(result.reason, 'invalid-ammo');
  assert.equal(roll.terms.length, 0);
  assert.equal(roll.resetCalls, 0);
  assert.equal(message.data.flags['foundry-rme'], undefined);
});

// ---------------------------------------------------------------------------
// handleAmmoDamageConfig
// ---------------------------------------------------------------------------

function damageConfigWithAmmunition(ammoId, rolls, subject = rifleSubject()) {
  return {
    subject,
    ammunition: { flags: { 'foundry-rme': { ammoId } } },
    rolls,
  };
}

// A default rifle attack subject for damage-config fixtures (the dnd5e6
// ActivityMixin.rollDamage path sets config.subject to the activity).
function rifleSubject() {
  const { actor } = makeAmmoActor([
    weaponItem('w1', RIFLE, { reserveItemId: 'a1', loaded: 4, loadedAmmoId: 'rifle/match-grade-rifle-cartridge' }),
    ammoItem('a1', { family: 'rifle', ammoId: 'rifle/rifle-cartridge' }),
  ]);
  return attackActivity(actor, actor.items.get('w1'));
}

// A damage-config event that points at the attack chat card id.
function eventMessageConfig(messageId, rolls, subject = null) {
  const config = {
    event: { target: { closest: () => ({ dataset: { messageId } }) } },
    rolls,
  };
  if (subject) config.subject = subject;
  return config;
}

// Install a fake attack chat card carrying ammo + weapon provenance.
function installAmmoCard(id, ammoId, weaponCatalogId) {
  globalThis.game = {
    messages: {
      get(mid) {
        if (mid !== id) return null;
        return {
          getFlag(scope, key) {
            if (key === 'ammoId') return ammoId;
            if (key === 'weaponCatalogId') return weaponCatalogId;
            return null;
          },
          flags: { 'foundry-rme': { ammoId, weaponCatalogId } },
        };
      },
    },
  };
}

test('handleAmmoDamageConfig: elemental ammo adds a separate typed damage roll', () => {
  const rolls = [{ parts: ['1d8'], options: { type: 'piercing' } }];
  const config = damageConfigWithAmmunition('arrow/fire-arrows', rolls, weaponSubject(SHORTBOW));
  const message = { data: { flags: {} } };

  const result = handleAmmoDamageConfig(config, {}, message, equipment, ammoCatalog);

  assert.equal(result.handled, true);
  assert.equal(result.applied, true);
  assert.equal(config.rolls.length, 2);
  assert.deepEqual(config.rolls[1], { parts: ['1d4'], options: { type: 'fire' } });
  // No flat damage bonus for an elemental arrow.
  assert.deepEqual(config.rolls[0].parts, ['1d8']);
  assert.equal(message.data.flags['foundry-rme'].ammoId, 'arrow/fire-arrows');
});

test('handleAmmoDamageConfig: +1/+2 ammunition appends a plain numeric flat bonus to base damage', () => {
  // The flat ammo bonus is pushed as a plain numeric string ('1', '2'), not
  // '+1'/'+2', so the dnd5e BasicRoll ' + ' join of `parts` never builds a
  // malformed '2d8 + +1' double-plus formula.
  const rolls = [{ parts: ['2d8'], options: {} }];
  const config = damageConfigWithAmmunition('rifle/match-grade-rifle-cartridge', rolls);
  const message = { data: { flags: {} } };

  handleAmmoDamageConfig(config, {}, message, equipment, ammoCatalog);
  assert.deepEqual(config.rolls[0].parts, ['2d8', '1']);
  assert.ok(!config.rolls[0].parts.join(' + ').includes('+ +'));
  assert.equal(message.data.flags['foundry-rme'].ammoId, 'rifle/match-grade-rifle-cartridge');

  const rolls2 = [{ parts: ['2d8'], options: {} }];
  const config2 = damageConfigWithAmmunition('rifle/masterwork-rifle-cartridge', rolls2);
  handleAmmoDamageConfig(config2, {}, message, equipment, ammoCatalog);
  assert.deepEqual(config2.rolls[0].parts, ['2d8', '2']);
  assert.ok(!config2.rolls[0].parts.join(' + ').includes('+ +'));
});

test('handleAmmoDamageConfig: does NOT add the MPL 2d6 payload automatically', () => {
  const rolls = [{ parts: ['1d6'], options: { type: 'bludgeoning' } }];
  const config = damageConfigWithAmmunition('mpl/mpl-grenade', rolls, weaponSubject(MPL));
  const message = { data: { flags: {} } };

  const result = handleAmmoDamageConfig(config, {}, message, equipment, ammoCatalog);

  assert.equal(result.handled, true);
  // Only the weapon's own damage roll remains; the separate 2d6 is NOT appended.
  assert.equal(config.rolls.length, 1);
  assert.deepEqual(config.rolls[0].parts, ['1d6']);
  // The blast/save rider is recorded for manual handling, not auto-applied.
  const rider = message.data.flags['foundry-rme'].rider;
  assert.deepEqual(rider.save, { ability: 'dex', dc: 13 });
  assert.equal(rider.halfOnSave, true);
  assert.equal(rider.radiusFeet, 10);
});

test('handleAmmoDamageConfig: poison adds typed poison damage and claims no condition', () => {
  const rolls = [{ parts: ['1d8'], options: {} }];
  const config = damageConfigWithAmmunition('arrow/poison-arrows', rolls, weaponSubject(SHORTBOW));
  const message = { data: { flags: {} } };

  handleAmmoDamageConfig(config, {}, message, equipment, ammoCatalog);

  assert.equal(config.rolls.length, 2);
  assert.deepEqual(config.rolls[1], { parts: ['1d4'], options: { type: 'poison' } });
  const rider = message.data.flags['foundry-rme'].rider;
  assert.equal(rider.condition, null);
});

test('handleAmmoDamageConfig: buckshot reduces one base die (2d8 to 1d8) and leaves ambiguous unchanged', () => {
  const rolls = [{ parts: ['2d8', '+3'], options: {} }];
  const config = damageConfigWithAmmunition('shotgun/buckshot', rolls, weaponSubject(SHOTGUN));
  const message = { data: { flags: {} } };

  handleAmmoDamageConfig(config, {}, message, equipment, ammoCatalog);
  assert.equal(config.rolls[0].parts[0], '1d8');
  const rider = message.data.flags['foundry-rme'].rider;
  assert.equal(rider.fewerBaseDie, true);
  assert.equal(rider.cone, true);

  // An ambiguous formula (not a bare NdM) is left unchanged.
  const ambiguous = [{ parts: ['2d8+1d6', '+3'], options: {} }];
  const config2 = damageConfigWithAmmunition('shotgun/buckshot', ambiguous);
  handleAmmoDamageConfig(config2, {}, message, equipment, ammoCatalog);
  assert.equal(config2.rolls[0].parts[0], '2d8+1d6');
});

test('handleAmmoDamageConfig: never applies twice (idempotent config marker)', () => {
  const rolls = [{ parts: ['1d8'], options: {} }];
  const config = damageConfigWithAmmunition('arrow/fire-arrows', rolls, weaponSubject(SHORTBOW));
  const message = { data: { flags: {} } };

  const first = handleAmmoDamageConfig(config, {}, message, equipment, ammoCatalog);
  const lengthAfterFirst = config.rolls.length;
  const second = handleAmmoDamageConfig(config, {}, message, equipment, ammoCatalog);

  assert.equal(first.applied, true);
  assert.equal(second.applied, false);
  assert.equal(second.reason, 'already-applied');
  assert.equal(config.rolls.length, lengthAfterFirst);
  assert.equal(config.rmeAmmoDamageApplied, true);
});

test('handleAmmoDamageConfig: provenance comes from the originating chat card, not current ammo', () => {
  globalThis.game = {
    messages: {
      get(id) {
        if (id !== 'msg1') return null;
        return {
          getFlag(scope, key) {
            if (key === 'ammoId') return 'arrow/fire-arrows';
            if (key === 'weaponCatalogId') return SHORTBOW;
            return null;
          },
          flags: { 'foundry-rme': { ammoId: 'arrow/fire-arrows', weaponCatalogId: SHORTBOW } },
        };
      },
    },
  };
  const rolls = [{ parts: ['1d8'], options: {} }];
  const config = {
    subject: weaponSubject(SHORTBOW),
    event: { target: { closest: () => ({ dataset: { messageId: 'msg1' } }) } },
    rolls,
  };
  const message = { data: { flags: {} } };

  const result = handleAmmoDamageConfig(config, {}, message, equipment, ammoCatalog);

  assert.equal(result.handled, true);
  assert.equal(config.rolls.length, 2);
  assert.deepEqual(config.rolls[1], { parts: ['1d4'], options: { type: 'fire' } });
});

test('handleAmmoDamageConfig: no fallback when the chat card lacks an ammoId', () => {
  globalThis.game = {
    messages: {
      get() {
        return {
          getFlag(scope, key) {
            if (key === 'weaponCatalogId') return RIFLE;
            return null;
          },
          flags: { 'foundry-rme': { weaponCatalogId: RIFLE } },
        };
      },
    },
  };
  const rolls = [{ parts: ['1d8'], options: {} }];
  const config = {
    // The card carries no RME ammo flag, and there is no config.ammunition, so
    // the damage roll must NOT be attributed to the weapon's current ammo.
    subject: rifleSubject(),
    event: { target: { closest: () => ({ dataset: { messageId: 'msg-no-ammo' } }) } },
    rolls,
  };
  const message = { data: { flags: {} } };

  const result = handleAmmoDamageConfig(config, {}, message, equipment, ammoCatalog);

  assert.equal(result.handled, false);
  assert.equal(result.reason, 'no-ammo-id');
  assert.equal(config.rolls.length, 1);
});

test('handleAmmoDamageConfig: no effect without rolls array', () => {
  const config = {
    subject: weaponSubject(SHORTBOW),
    ammunition: { flags: { 'foundry-rme': { ammoId: 'arrow/fire-arrows' } } },
    rolls: [],
  };
  const message = { data: { flags: {} } };

  const result = handleAmmoDamageConfig(config, {}, message, equipment, ammoCatalog);

  assert.equal(result.handled, true);
  assert.equal(result.applied, false);
  assert.equal(result.reason, 'no-rolls');
});

test('handleAmmoDamageConfig: skips a non-attack or melee subject', () => {
  const { actor } = makeAmmoActor([
    weaponItem('w1', RIFLE, { reserveItemId: 'a1', loaded: 4, loadedAmmoId: 'rifle/match-grade-rifle-cartridge' }),
    ammoItem('a1', { family: 'rifle', ammoId: 'rifle/rifle-cartridge' }),
  ]);
  const weapon = actor.items.get('w1');

  // A utility subject on the same config must not apply ammo damage.
  const rolls = [{ parts: ['1d8'], options: {} }];
  const utility = { ...attackActivity(actor, weapon), type: 'utility' };
  const config = {
    subject: utility,
    ammunition: { flags: { 'foundry-rme': { ammoId: 'arrow/fire-arrows' } } },
    rolls,
  };
  const result = handleAmmoDamageConfig(config, {}, { data: { flags: {} } }, equipment, ammoCatalog);
  assert.equal(result.handled, false);
  assert.equal(result.applied, false);
  assert.equal(config.rolls.length, 1);

  // A melee attack mode is likewise not an RME shot.
  const rolls2 = [{ parts: ['1d8'], options: {} }];
  const config2 = {
    subject: attackActivity(actor, weapon),
    attackMode: 'melee',
    ammunition: { flags: { 'foundry-rme': { ammoId: 'arrow/fire-arrows' } } },
    rolls: rolls2,
  };
  const result2 = handleAmmoDamageConfig(config2, {}, { data: { flags: {} } }, equipment, ammoCatalog);
  assert.equal(result2.handled, false);
  assert.equal(rolls2.length, 1);
});

test('handleAmmoDamageConfig: null subject with a valid ammo card applies nothing', () => {
  installAmmoCard('m-null', 'arrow/fire-arrows', RIFLE);
  const rolls = [{ parts: ['1d8'], options: {} }];
  const config = eventMessageConfig('m-null', rolls);
  const result = handleAmmoDamageConfig(config, {}, { data: { flags: {} } }, equipment, ammoCatalog);

  assert.equal(result.handled, false);
  assert.equal(result.applied, false);
  assert.equal(config.rolls.length, 1);
});

test('handleAmmoDamageConfig: unrelated (untagged) subject with a valid ammo card applies nothing', () => {
  const { actor } = makeAmmoActor([
    weaponItem('w1', 'axes/battle-axe', null),
  ]);
  const weapon = actor.items.get('w1');
  installAmmoCard('m-untagged', 'arrow/fire-arrows', RIFLE);
  const rolls = [{ parts: ['1d8'], options: {} }];
  const config = eventMessageConfig('m-untagged', rolls, attackActivity(actor, weapon));
  const result = handleAmmoDamageConfig(config, {}, { data: { flags: {} } }, equipment, ammoCatalog);

  assert.equal(result.handled, false);
  assert.equal(result.applied, false);
  assert.equal(config.rolls.length, 1);
});

test('handleAmmoDamageConfig: a card from another weapon applies no bonus to this subject', () => {
  const { actor } = makeAmmoActor([
    weaponItem('w1', RIFLE, { reserveItemId: 'a1', loaded: 4, loadedAmmoId: 'rifle/masterwork-rifle-cartridge' }),
    ammoItem('a1', { family: 'rifle', ammoId: 'rifle/rifle-cartridge' }),
  ]);
  const weapon = actor.items.get('w1');
  // The rifle subject rolls damage, but the ammo came from a shortbow card.
  installAmmoCard('m-other-weapon', 'arrow/fire-arrows', SHORTBOW);
  const rolls = [{ parts: ['1d8'], options: {} }];
  const config = eventMessageConfig('m-other-weapon', rolls, attackActivity(actor, weapon));
  const result = handleAmmoDamageConfig(config, {}, { data: { flags: {} } }, equipment, ammoCatalog);

  assert.equal(result.handled, false);
  assert.equal(result.applied, false);
  assert.equal(config.rolls.length, 1);
});

test('handleAmmoDamageConfig: a matching weapon card applies the ammo bonus', () => {
  const { actor } = makeAmmoActor([
    weaponItem('w1', RIFLE, { reserveItemId: 'a1', loaded: 4, loadedAmmoId: 'rifle/masterwork-rifle-cartridge' }),
    ammoItem('a1', { family: 'rifle', ammoId: 'rifle/rifle-cartridge' }),
  ]);
  const weapon = actor.items.get('w1');
  installAmmoCard('m-match', 'rifle/masterwork-rifle-cartridge', RIFLE);
  const rolls = [{ parts: ['1d8'], options: {} }];
  const config = eventMessageConfig('m-match', rolls, attackActivity(actor, weapon));
  const result = handleAmmoDamageConfig(config, {}, { data: { flags: {} } }, equipment, ammoCatalog);

  assert.equal(result.handled, true);
  assert.equal(result.applied, true);
  assert.deepEqual(config.rolls[0].parts, ['1d8', '2']);
});

test('handleAmmoDamageConfig: a legacy card without weaponCatalogId applies nothing', () => {
  const { actor } = makeAmmoActor([
    weaponItem('w1', RIFLE, { reserveItemId: 'a1', loaded: 4, loadedAmmoId: 'rifle/masterwork-rifle-cartridge' }),
    ammoItem('a1', { family: 'rifle', ammoId: 'rifle/rifle-cartridge' }),
  ]);
  const weapon = actor.items.get('w1');
  globalThis.game = {
    messages: {
      get() {
        return {
          getFlag(scope, key) {
            if (key === 'ammoId') return 'rifle/masterwork-rifle-cartridge';
            return null;
          },
          flags: { 'foundry-rme': { ammoId: 'rifle/masterwork-rifle-cartridge' } },
        };
      },
    },
  };
  const rolls = [{ parts: ['1d8'], options: {} }];
  const config = eventMessageConfig('m-legacy', rolls, attackActivity(actor, weapon));
  const result = handleAmmoDamageConfig(config, {}, { data: { flags: {} } }, equipment, ammoCatalog);

  assert.equal(result.handled, false);
  assert.equal(result.applied, false);
  assert.equal(config.rolls.length, 1);
});

test('handleAmmoDamageConfig: rifle subject with arrow ammoId in explicit config adds no damage', () => {
  const rolls = [{ parts: ['1d8'], options: { type: 'piercing' } }];
  const config = damageConfigWithAmmunition('arrow/fire-arrows', rolls); // default rifleSubject
  const message = { data: { flags: {} } };

  const result = handleAmmoDamageConfig(config, {}, message, equipment, ammoCatalog);

  assert.equal(result.handled, false);
  assert.equal(result.applied, false);
  assert.equal(result.reason, 'invalid-ammo');
  // No cross-item bonus: the weapon's base damage roll is untouched, and no
  // provenance flag is written for the mismatched arrow ammo.
  assert.equal(config.rolls.length, 1);
  assert.deepEqual(config.rolls[0].parts, ['1d8']);
  assert.deepEqual(message.data.flags, {});
});

test('handleAmmoDamageConfig: arrow subject with a rifle id card adds no damage', () => {
  const { actor } = makeAmmoActor([weaponItem('w1', SHORTBOW)]);
  const weapon = actor.items.get('w1');
  // The card's weaponCatalogId matches the arrow subject, but its ammo id is a
  // rifle cartridge, which is not a valid id for the arrow family.
  installAmmoCard('m-rifle-card', 'rifle/masterwork-rifle-cartridge', SHORTBOW);
  const rolls = [{ parts: ['1d8'], options: {} }];
  const config = eventMessageConfig('m-rifle-card', rolls, attackActivity(actor, weapon));
  const message = { data: { flags: {} } };

  const result = handleAmmoDamageConfig(config, {}, message, equipment, ammoCatalog);

  assert.equal(result.handled, false);
  assert.equal(result.applied, false);
  assert.equal(result.reason, 'invalid-ammo');
  assert.equal(config.rolls.length, 1);
  assert.deepEqual(config.rolls[0].parts, ['1d8']);
  assert.deepEqual(message.data.flags, {});
});

test('handleAmmoDamageConfig: no explicit-ammo fallback when a chat card lacks an ammoId', () => {
  globalThis.game = {
    messages: {
      get() {
        return {
          getFlag(scope, key) {
            if (key === 'weaponCatalogId') return RIFLE;
            return null;
          },
          flags: { 'foundry-rme': { weaponCatalogId: RIFLE } },
        };
      },
    },
  };
  const rolls = [{ parts: ['1d8'], options: {} }];
  const config = {
    // The card is present, so it is authoritative: the explicit arrow ammo must
    // NOT be used to label a damage roll whose card carries no ammoId.
    subject: rifleSubject(),
    event: { target: { closest: () => ({ dataset: { messageId: 'm-no-ammo' } }) } },
    ammunition: { flags: { 'foundry-rme': { ammoId: 'arrow/fire-arrows' } } },
    rolls,
  };
  const message = { data: { flags: {} } };

  const result = handleAmmoDamageConfig(config, {}, message, equipment, ammoCatalog);

  assert.equal(result.handled, false);
  assert.equal(result.reason, 'no-ammo-id');
  assert.equal(config.rolls.length, 1);
  assert.deepEqual(message.data.flags, {});
});

test('handleAmmoDamageConfig: a legitimate javelin and a matching rifle variant are accepted', () => {
  // The Portable Ballista (family 'javelin') accepts the fixed 'javelin'
  // sentinel; it is a valid provenance match and appends no cross-item bonus.
  const jRolls = [{ parts: ['1d8'], options: {} }];
  const jConfig = damageConfigWithAmmunition('javelin', jRolls, weaponSubject(PORTABLE_BALLISTA));
  const jMessage = { data: { flags: {} } };
  const jResult = handleAmmoDamageConfig(jConfig, {}, jMessage, equipment, ammoCatalog);

  assert.equal(jResult.handled, true);
  assert.equal(jResult.applied, true);
  assert.equal(jResult.ammoId, 'javelin');
  assert.equal(jConfig.rolls.length, 1);
  assert.deepEqual(jConfig.rolls[0].parts, ['1d8']);

  // A matching rifle +2 variant on the rifle is likewise accepted.
  const rRolls = [{ parts: ['1d8'], options: {} }];
  const rConfig = damageConfigWithAmmunition('rifle/masterwork-rifle-cartridge', rRolls); // rifleSubject
  const rMessage = { data: { flags: {} } };
  const rResult = handleAmmoDamageConfig(rConfig, {}, rMessage, equipment, ammoCatalog);

  assert.equal(rResult.handled, true);
  assert.equal(rResult.applied, true);
  assert.equal(rResult.ammoId, 'rifle/masterwork-rifle-cartridge');
  assert.deepEqual(rConfig.rolls[0].parts, ['1d8', '2']);
});

// ---------------------------------------------------------------------------
// No Foundry globals outside guards
// ---------------------------------------------------------------------------

test('module and functions tolerate absent Foundry/global game references', () => {
  // No globalThis.foundry and no globalThis.game set in this test.
  // handleAmmoAttackRoll with a +1 ammo and no terms library: no throw.
  const { actor } = makeAmmoActor([
    weaponItem('w1', RIFLE, { reserveItemId: 'a1', loaded: 4, loadedAmmoId: 'rifle/match-grade-rifle-cartridge' }),
    ammoItem('a1', { family: 'rifle', ammoId: 'rifle/rifle-cartridge' }),
  ]);
  const roll = makeRoll({ terms: [], options: { attackMode: 'ranged' } });
  assert.doesNotThrow(() =>
    handleAmmoAttackRoll([roll], { subject: attackActivity(actor, actor.items.get('w1')) }, {}, { data: { flags: {} } }, equipment, ammoCatalog)
  );

  // handleAmmoDamageConfig with no event/ammunition: no throw.
  assert.doesNotThrow(() =>
    handleAmmoDamageConfig({ rolls: [{ parts: ['1d8'], options: {} }] }, {}, { data: { flags: {} } }, equipment, ammoCatalog)
  );

  // ammoEffectDetails requires no globals at all.
  assert.equal(typeof ammoEffectDetails('crossbow/plus-1-bolts', ammoCatalog), 'string');
});
