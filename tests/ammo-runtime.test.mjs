import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  assignActorAmmo,
  reloadActorAmmo,
  spendActorShot,
  getAmmoState,
  handlePreUseActivity,
  handleActivityConsumption,
  handlePostAttackRollConfiguration,
  handleRollAttack,
  handlePostRollAttack,
} from '../src/ammo-runtime.mjs';

const catalog = JSON.parse(await readFile(new URL('../data/catalog.json', import.meta.url), 'utf8'));
const equipment = catalog.equipment;

const RIFLE = 'firearms/bolt-action-rifle';
const SHORTBOW = 'bows/shortbow';

// ---------------------------------------------------------------------------
// Fixtures / helpers
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
  const calls = [];
  const actor = {
    id: 'actor1',
    documentName: 'Actor',
    isOwner,
    items: list,
    getFlag(scope, key) { return state[scope]?.[key]; },
    updateCalls: 0,
    async updateEmbeddedDocuments(type, patches) {
      actor.updateCalls += 1;
      calls.push(structuredClone(patches));
      for (const patch of patches) {
        const item = byId.get(patch._id);
        if (!item) continue;
        for (const [key, value] of Object.entries(patch)) {
          if (key === '_id') continue;
          setPath(item, key, value);
        }
      }
      return patches;
    },
  };
  return { actor, calls, byId, list };
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

function attackActivity(actor, item, { type = 'attack', flags = {} } = {}) {
  return { type, actor, item, flags, id: 'act1' };
}

function reloadActivity(actor, item, optionId) {
  return { type: 'utility', actor, item, id: 'reload1', flags: { 'foundry-rme': { reloadOptionId: optionId } } };
}

function captureUi() {
  const warns = [];
  const errors = [];
  const original = globalThis.ui;
  globalThis.ui = {
    notifications: {
      warn: (msg) => warns.push(String(msg)),
      error: (msg) => errors.push(String(msg)),
    },
  };
  return {
    warns,
    errors,
    restore() { globalThis.ui = original; },
  };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

// Mimic the dnd5e order: config gate -> rollAttack -> postRollAttack. Returns
// whether the attack actually fired (i.e. was not blocked pre-roll).
async function runAttackSequence(actor, weaponId, equipment) {
  const weapon = actor.items.get(weaponId);
  const activity = attackActivity(actor, weapon);
  const roll = [{ options: { attackMode: 'ranged' } }];
  const fired = handlePostAttackRollConfiguration(roll, { subject: activity }, {}, {}, equipment);
  if (fired === false) return false;
  handleRollAttack(roll, { subject: activity }, equipment);
  handlePostRollAttack(roll, { subject: activity }, equipment);
  await flush();
  return true;
}

const assertWarned = (ui) => assert.ok(ui.warns.length > 0, 'expected a notification warning');

// ---------------------------------------------------------------------------
// Assignment
// ---------------------------------------------------------------------------

test('assignActorAmmo assigns a compatible reserve and persists it in a single update', async () => {
  const { actor, calls, byId } = makeAmmoActor([
    weaponItem('w1', RIFLE),
    ammoItem('a1', { family: 'rifle', ammoId: 'rifle/rifle-cartridge' }),
  ]);
  const result = await assignActorAmmo(actor, 'w1', 'a1', equipment);
  assert.equal(actor.updateCalls, 1);
  assert.equal(calls[0].length, 1);
  assert.equal(calls[0][0]._id, 'w1');
  assert.equal(calls[0][0]['flags.foundry-rme.ammunition'].reserveItemId, 'a1');
  assert.equal(byId.get('w1').flags['foundry-rme'].ammunition.reserveItemId, 'a1');
  assert.equal(result.state.reserveItemId, 'a1');
});

test('assignActorAmmo rejects an incompatible ammo stack', async () => {
  const { actor } = makeAmmoActor([
    weaponItem('w1', RIFLE),
    ammoItem('b1', { family: 'crossbow', ammoId: 'crossbow/bolts' }),
  ]);
  await assert.rejects(
    assignActorAmmo(actor, 'w1', 'b1', equipment),
    /compatible/i
  );
});

// ---------------------------------------------------------------------------
// Spending
// ---------------------------------------------------------------------------

test('spendActorShot on a direct-consumption bow decrements the stack exactly once', async () => {
  const { actor, calls, byId } = makeAmmoActor([
    weaponItem('w1', SHORTBOW, { reserveItemId: 'a1' }),
    ammoItem('a1', { family: 'arrow', ammoId: 'arrow/arrows' }),
  ]);
  await spendActorShot(actor, 'w1', equipment);
  assert.equal(actor.updateCalls, 1);
  assert.equal(calls[0].length, 1);
  assert.equal(calls[0][0]._id, 'a1');
  assert.equal(calls[0][0]['system.quantity'], 19);
  assert.equal(byId.get('a1').system.quantity, 19);
  // Direct consumption never rewrites the weapon ammunition state.
  assert.deepEqual(byId.get('w1').flags['foundry-rme'].ammunition, { reserveItemId: 'a1' });
});

test('spendActorShot on a magazine weapon decrements loaded and never the stack (no double spend)', async () => {
  const { actor, calls, byId } = makeAmmoActor([
    weaponItem('w1', RIFLE, { reserveItemId: 'a1', loaded: 4, loadedAmmoId: 'rifle/rifle-cartridge' }),
    ammoItem('a1', { family: 'rifle', ammoId: 'rifle/rifle-cartridge' }),
  ]);
  await spendActorShot(actor, 'w1', equipment);
  assert.equal(actor.updateCalls, 1);
  assert.equal(calls[0].length, 1);
  assert.equal(calls[0][0]._id, 'w1');
  const state = calls[0][0]['flags.foundry-rme.ammunition'];
  assert.equal(state.loaded, 3);
  assert.equal(state.reserveItemId, 'a1');
  assert.equal(state.loadedAmmoId, 'rifle/rifle-cartridge');
  // The reserve stack is untouched: only the magazine was decremented.
  assert.equal(byId.get('a1').system.quantity, 20);
});

// ---------------------------------------------------------------------------
// Reload
// ---------------------------------------------------------------------------

test('reloadActorAmmo full action fills the magazine to its exact capacity', async () => {
  const { actor, calls, byId } = makeAmmoActor([
    weaponItem('w1', RIFLE, { reserveItemId: 'a1', loaded: 0, loadedAmmoId: null }),
    ammoItem('a1', { family: 'rifle', ammoId: 'rifle/rifle-cartridge' }),
  ]);
  const result = await reloadActorAmmo(actor, 'w1', 'action-full', equipment);
  assert.equal(result.state.loaded, 4);
  assert.equal(byId.get('w1').flags['foundry-rme'].ammunition.loaded, 4);
  assert.equal(byId.get('a1').system.quantity, 16);
  assert.equal(actor.updateCalls, 1);
  const ids = calls[0].map((p) => p._id).sort();
  assert.deepEqual(ids, ['a1', 'w1']);
});

test('reloadActorAmmo single-cartridge option loads exactly one round', async () => {
  const { actor, byId } = makeAmmoActor([
    weaponItem('w1', RIFLE, { reserveItemId: 'a1', loaded: 0, loadedAmmoId: null }),
    ammoItem('a1', { family: 'rifle', ammoId: 'rifle/rifle-cartridge' }),
  ], { 'foundry-rme': { training: { items: { [RIFLE]: 'expert' } } } });
  const result = await reloadActorAmmo(actor, 'w1', 'special-single', equipment);
  assert.equal(result.state.loaded, 1);
  assert.equal(byId.get('w1').flags['foundry-rme'].ammunition.loaded, 1);
  assert.equal(byId.get('a1').system.quantity, 19);
});

test('reloadActorAmmo with a shortage transfers only the rounds available', async () => {
  const { actor, byId } = makeAmmoActor([
    weaponItem('w1', RIFLE, { reserveItemId: 'a1', loaded: 0, loadedAmmoId: null }),
    ammoItem('a1', { family: 'rifle', ammoId: 'rifle/rifle-cartridge', qty: 2 }),
  ]);
  const result = await reloadActorAmmo(actor, 'w1', 'action-full', equipment);
  assert.equal(result.state.loaded, 2);
  assert.equal(byId.get('a1').system.quantity, 0);
});

// ---------------------------------------------------------------------------
// Attack config gate
// ---------------------------------------------------------------------------

test('postAttackRollConfiguration blocks an empty magazine with a warning', () => {
  const ui = captureUi();
  try {
    const { actor } = makeAmmoActor([
      weaponItem('w1', RIFLE, { reserveItemId: 'a1', loaded: 0, loadedAmmoId: 'rifle/rifle-cartridge' }),
      ammoItem('a1', { family: 'rifle', ammoId: 'rifle/rifle-cartridge' }),
    ]);
    const activity = attackActivity(actor, actor.items.get('w1'));
    const result = handlePostAttackRollConfiguration(
      [{ options: { attackMode: 'ranged' } }],
      { subject: activity }, {}, {}, equipment
    );
    assert.equal(result, false);
    assertWarned(ui);
  } finally {
    ui.restore();
  }
});

test('postAttackRollConfiguration only blocks the relevant attack configs', () => {
  const ui = captureUi();
  try {
    const { actor } = makeAmmoActor([
      weaponItem('w1', RIFLE, { reserveItemId: 'a1', loaded: 4, loadedAmmoId: 'rifle/rifle-cartridge' }),
      ammoItem('a1', { family: 'rifle', ammoId: 'rifle/rifle-cartridge' }),
    ]);
    const weapon = actor.items.get('w1');
    const attack = attackActivity(actor, weapon);
    const roll = [{ options: { attackMode: 'ranged' } }];
    // A loaded magazine is allowed.
    assert.equal(handlePostAttackRollConfiguration(roll, { subject: attack }, {}, {}, equipment), true);
    // A non-attack activity is not touched.
    assert.equal(handlePostAttackRollConfiguration(roll, { subject: attackActivity(actor, weapon, { type: 'utility' }) }, {}, {}, equipment), true);
    // A non-owned actor is not touched.
    assert.equal(handlePostAttackRollConfiguration(roll, { subject: attackActivity({ ...actor, isOwner: false }, weapon) }, {}, {}, equipment), true);
    // A melee attack mode is not touched (no ammunition consumed).
    assert.equal(handlePostAttackRollConfiguration([{ options: { attackMode: 'melee' } }], { subject: attack }, {}, {}, equipment), true);
    // No config.subject means an unrelated roll is not touched.
    assert.equal(handlePostAttackRollConfiguration(roll, {}, {}, {}, equipment), true);
    // A non-RME weapon (no catalog tag) is not touched.
    const plainWeapon = { ...weapon, flags: {} };
    assert.equal(handlePostAttackRollConfiguration(roll, { subject: attackActivity(actor, plainWeapon) }, {}, {}, equipment), true);
    assert.equal(ui.warns.length, 0);
  } finally {
    ui.restore();
  }
});

test('canceled pre-roll does not spend any ammunition', async () => {
  const { actor } = makeAmmoActor([
    weaponItem('w1', RIFLE, { reserveItemId: 'a1', loaded: 0, loadedAmmoId: 'rifle/rifle-cartridge' }),
    ammoItem('a1', { family: 'rifle', ammoId: 'rifle/rifle-cartridge' }),
  ]);
  const fired = await runAttackSequence(actor, 'w1', equipment);
  assert.equal(fired, false);
  assert.equal(actor.updateCalls, 0);
  assert.equal(actor.items.get('w1').flags['foundry-rme'].ammunition.loaded, 0);
});

test('an allowed attack spends exactly one round of ammunition', async () => {
  const ui = captureUi();
  try {
    const { actor, byId } = makeAmmoActor([
      weaponItem('w1', RIFLE, { reserveItemId: 'a1', loaded: 4, loadedAmmoId: 'rifle/rifle-cartridge' }),
      ammoItem('a1', { family: 'rifle', ammoId: 'rifle/rifle-cartridge' }),
    ]);
    const fired = await runAttackSequence(actor, 'w1', equipment);
    assert.equal(fired, true);
    assert.equal(byId.get('w1').flags['foundry-rme'].ammunition.loaded, 3);
    assert.equal(byId.get('a1').system.quantity, 20);
    assert.equal(actor.updateCalls, 1);
    assert.equal(ui.warns.length, 0);
  } finally {
    ui.restore();
  }
});

// ---------------------------------------------------------------------------
// Reload activity gates
// ---------------------------------------------------------------------------

test('preUseActivity blocks an invalid reload utility and warns', () => {
  const ui = captureUi();
  try {
    const { actor } = makeAmmoActor([
      weaponItem('w1', RIFLE, { reserveItemId: 'a1', loaded: 0, loadedAmmoId: null }),
      ammoItem('a1', { family: 'rifle', ammoId: 'rifle/rifle-cartridge', qty: 0 }),
    ]);
    const activity = reloadActivity(actor, actor.items.get('w1'), 'action-full');
    const result = handlePreUseActivity(activity, {}, {}, {}, equipment);
    assert.equal(result, false);
    assertWarned(ui);
  } finally {
    ui.restore();
  }
});

test('preUseActivity ignores non-reload, non-owned, and non-RME activities', () => {
  const ui = captureUi();
  try {
    const { actor } = makeAmmoActor([
      weaponItem('w1', RIFLE, { reserveItemId: 'a1', loaded: 0, loadedAmmoId: null }),
      ammoItem('a1', { family: 'rifle', ammoId: 'rifle/rifle-cartridge' }),
    ]);
    const weapon = actor.items.get('w1');
    const reload = reloadActivity(actor, weapon, 'action-full');
    // A valid reload utility passes.
    assert.equal(handlePreUseActivity(reload, {}, {}, {}, equipment), true);
    // A non-reload activity (no flag) passes untouched.
    assert.equal(handlePreUseActivity({ type: 'utility', actor, item: weapon, flags: {} }, {}, {}, {}, equipment), true);
    // A non-owned actor passes untouched.
    assert.equal(handlePreUseActivity(reloadActivity({ ...actor, isOwner: false }, weapon, 'action-full'), {}, {}, {}, equipment), true);
    // A non-RME weapon passes untouched.
    assert.equal(handlePreUseActivity(reloadActivity(actor, { ...weapon, flags: {} }, 'action-full'), {}, {}, {}, equipment), true);
    assert.equal(ui.warns.length, 0);
  } finally {
    ui.restore();
  }
});

test('activityConsumption injects weapon and ammo patches for a valid reload utility', () => {
  const { actor } = makeAmmoActor([
    weaponItem('w1', RIFLE, { reserveItemId: 'a1', loaded: 0, loadedAmmoId: null }),
    ammoItem('a1', { family: 'rifle', ammoId: 'rifle/rifle-cartridge' }),
  ]);
  const activity = reloadActivity(actor, actor.items.get('w1'), 'action-full');
  const updates = { item: [] };
  const result = handleActivityConsumption(activity, {}, {}, updates, equipment);
  assert.equal(result, true);
  assert.equal(updates.item.length, 2);
  const weaponPatch = updates.item.find((p) => p._id === 'w1');
  const ammoPatch = updates.item.find((p) => p._id === 'a1');
  assert.equal(weaponPatch['flags.foundry-rme.ammunition'].loaded, 4);
  assert.equal(ammoPatch['system.quantity'], 16);
});

test('activityConsumption returns false and warns when a reload is invalid', () => {
  const ui = captureUi();
  try {
    const { actor } = makeAmmoActor([
      weaponItem('w1', RIFLE, { reserveItemId: 'a1', loaded: 0, loadedAmmoId: null }),
      ammoItem('a1', { family: 'rifle', ammoId: 'rifle/rifle-cartridge', qty: 0 }),
    ]);
    const activity = reloadActivity(actor, actor.items.get('w1'), 'action-full');
    const updates = { item: [] };
    const result = handleActivityConsumption(activity, {}, {}, updates, equipment);
    assert.equal(result, false);
    assert.equal(updates.item.length, 0);
    assertWarned(ui);
  } finally {
    ui.restore();
  }
});

// ---------------------------------------------------------------------------
// Reservations
// ---------------------------------------------------------------------------

test('postAttackRollConfiguration accounts for in-flight shot reservations', async () => {
  const ui = captureUi();
  try {
    const { actor } = makeAmmoActor([
      weaponItem('w1', RIFLE, { reserveItemId: 'a1', loaded: 1, loadedAmmoId: 'rifle/rifle-cartridge' }),
      ammoItem('a1', { family: 'rifle', ammoId: 'rifle/rifle-cartridge' }),
    ]);
    const activity = attackActivity(actor, actor.items.get('w1'));
    const roll = [{ options: { attackMode: 'ranged' } }];
    // One round loaded and no pending shot: allowed.
    assert.equal(handlePostAttackRollConfiguration(roll, { subject: activity }, {}, {}, equipment), true);
    // Reserve a pending shot; the pending shot consumes the only round, so a
    // second shot config must now block.
    handleRollAttack(roll, { subject: activity }, equipment);
    assert.equal(handlePostAttackRollConfiguration(roll, { subject: activity }, {}, {}, equipment), false);
    assertWarned(ui);
    // Clean up the reservation so it does not leak into later tests.
    handlePostRollAttack(roll, { subject: activity }, equipment);
    await flush();
  } finally {
    ui.restore();
  }
});

test('rollAttack takes a reservation and postRollAttack releases it after the spend', async () => {
  const { actor, byId } = makeAmmoActor([
    weaponItem('w1', RIFLE, { reserveItemId: 'a1', loaded: 2, loadedAmmoId: 'rifle/rifle-cartridge' }),
    ammoItem('a1', { family: 'rifle', ammoId: 'rifle/rifle-cartridge' }),
  ]);
  const activity = attackActivity(actor, actor.items.get('w1'));
  const roll = [{ options: { attackMode: 'ranged' } }];
  // Take a reservation for a pending shot.
  handleRollAttack(roll, { subject: activity }, equipment);
  // After the spend settles, the reservation is released and the round spent.
  handlePostRollAttack(roll, { subject: activity }, equipment);
  await flush();
  assert.equal(byId.get('w1').flags['foundry-rme'].ammunition.loaded, 1);
  // With the reservation released and one round remaining, a new shot is
  // allowed again.
  assert.equal(handlePostAttackRollConfiguration(roll, { subject: activity }, {}, {}, equipment), true);
});

test('postRollAttack without a prior rollAttack reservation does not spend', async () => {
  const { actor, byId } = makeAmmoActor([
    weaponItem('w1', RIFLE, { reserveItemId: 'a1', loaded: 4, loadedAmmoId: 'rifle/rifle-cartridge' }),
    ammoItem('a1', { family: 'rifle', ammoId: 'rifle/rifle-cartridge' }),
  ]);
  const activity = attackActivity(actor, actor.items.get('w1'));
  const roll = [{ options: { attackMode: 'ranged' } }];
  // No prior rollAttack reservation: the post hook must not spend.
  handlePostRollAttack(roll, { subject: activity }, equipment);
  await flush();
  assert.equal(actor.updateCalls, 0);
  assert.equal(byId.get('w1').flags['foundry-rme'].ammunition.loaded, 4);
});

test('duplicate postRollAttack for one roll spends exactly once', async () => {
  const { actor, byId } = makeAmmoActor([
    weaponItem('w1', RIFLE, { reserveItemId: 'a1', loaded: 4, loadedAmmoId: 'rifle/rifle-cartridge' }),
    ammoItem('a1', { family: 'rifle', ammoId: 'rifle/rifle-cartridge' }),
  ]);
  const activity = attackActivity(actor, actor.items.get('w1'));
  const roll = [{ options: { attackMode: 'ranged' } }];
  handleRollAttack(roll, { subject: activity }, equipment);
  handlePostRollAttack(roll, { subject: activity }, equipment);
  // A duplicate post hook for the same roll must not spend again.
  handlePostRollAttack(roll, { subject: activity }, equipment);
  await flush();
  assert.equal(actor.updateCalls, 1);
  assert.equal(byId.get('w1').flags['foundry-rme'].ammunition.loaded, 3);
});

test('postRollAttack with a mismatched roll object does not spend', async () => {
  const { actor, byId } = makeAmmoActor([
    weaponItem('w1', RIFLE, { reserveItemId: 'a1', loaded: 4, loadedAmmoId: 'rifle/rifle-cartridge' }),
    ammoItem('a1', { family: 'rifle', ammoId: 'rifle/rifle-cartridge' }),
  ]);
  const activity = attackActivity(actor, actor.items.get('w1'));
  const roll = [{ options: { attackMode: 'ranged' } }];
  handleRollAttack(roll, { subject: activity }, equipment);
  // A structurally identical but distinct roll object is not the reserved one.
  handlePostRollAttack([{ options: { attackMode: 'ranged' } }], { subject: activity }, equipment);
  await flush();
  assert.equal(actor.updateCalls, 0);
  assert.equal(byId.get('w1').flags['foundry-rme'].ammunition.loaded, 4);
  // Release the leftover reservation (taken for the correct roll) so it does
  // not leak into later tests.
  handlePostRollAttack(roll, { subject: activity }, equipment);
  await flush();
});

test('a canceled roll never spends ammunition', async () => {
  const { actor, byId } = makeAmmoActor([
    weaponItem('w1', RIFLE, { reserveItemId: 'a1', loaded: 4, loadedAmmoId: 'rifle/rifle-cartridge' }),
    ammoItem('a1', { family: 'rifle', ammoId: 'rifle/rifle-cartridge' }),
  ]);
  const activity = attackActivity(actor, actor.items.get('w1'));
  const roll = [{ options: { attackMode: 'ranged' } }];
  // rollAttack fires (taking a reservation), but the roll is canceled so the
  // post hook never runs: no ammunition is spent.
  handleRollAttack(roll, { subject: activity }, equipment);
  await flush();
  assert.equal(actor.updateCalls, 0);
  assert.equal(byId.get('w1').flags['foundry-rme'].ammunition.loaded, 4);
  // Release the leftover reservation so it does not leak into later tests.
  handlePostRollAttack(roll, { subject: activity }, equipment);
  await flush();
});

// ---------------------------------------------------------------------------
// Per-actor operation serialization
// ---------------------------------------------------------------------------

test('concurrent spends on one actor are serialized: no stale reads', async () => {
  const { actor, byId } = makeAmmoActor([
    weaponItem('w1', RIFLE, { reserveItemId: 'a1', loaded: 4, loadedAmmoId: 'rifle/rifle-cartridge' }),
    ammoItem('a1', { family: 'rifle', ammoId: 'rifle/rifle-cartridge' }),
  ]);
  await Promise.all([
    spendActorShot(actor, 'w1', equipment),
    spendActorShot(actor, 'w1', equipment),
  ]);
  // If the two spends had raced and both read loaded=4, the final value would
  // be 3. Serializing per actor yields 2.
  assert.equal(byId.get('w1').flags['foundry-rme'].ammunition.loaded, 2);
  assert.equal(actor.updateCalls, 2);
});

// ---------------------------------------------------------------------------
// State query
// ---------------------------------------------------------------------------

test('getAmmoState returns state, compatible items, capacity and options', () => {
  const { actor } = makeAmmoActor([
    weaponItem('w1', RIFLE, { reserveItemId: 'a1', loaded: 0, loadedAmmoId: null }),
    ammoItem('a1', { family: 'rifle', ammoId: 'rifle/rifle-cartridge' }),
    ammoItem('b1', { family: 'crossbow', ammoId: 'crossbow/bolts' }),
    ammoItem('e1', { family: 'rifle', ammoId: 'rifle/rifle-cartridge', qty: 0 }),
  ]);
  const state = getAmmoState(actor, 'w1', equipment);
  assert.equal(state.state.reserveItemId, 'a1');
  assert.equal(state.state.loaded, 0);
  assert.equal(state.capacity, 4);
  assert.ok(state.options.some((o) => o.id === 'action-full'));
  const ids = state.compatibleItems.map((i) => i.id);
  assert.deepEqual(ids, ['a1']);
  assert.equal(state.compatibleItems[0].quantity, 20);
});

test('getAmmoState returns an empty descriptor for an unknown weapon', () => {
  const { actor } = makeAmmoActor([weaponItem('w1', 'axes/battle-axe')]);
  const state = getAmmoState(actor, 'w1', equipment);
  assert.equal(state.capacity, 0);
  assert.deepEqual(state.compatibleItems, []);
  assert.deepEqual(state.options, []);
});
