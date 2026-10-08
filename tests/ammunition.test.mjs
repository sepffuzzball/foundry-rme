import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  ammoFamily,
  compatibleAmmo,
  magazineCapacity,
  reloadOptions,
  readAmmoState,
  planAssignAmmo,
  planReload,
  planShot,
  validAmmoIdForFamily,
} from '../src/ammunition.mjs';

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
const leverActionRifle = entry('firearms/lever-action-rifle');
const revolvingCarbine = entry('firearms/revolving-carbine');
const doubleBarrelledShotgun = entry('firearms/double-barrelled-shotgun');
const sawedOffShotgun = entry('firearms/sawed-off-shotgun');
const breakActionRevolver = entry('firearms/break-action-revolver');
const handCannon = entry('firearms/hand-cannon');
const multiPurposeLauncher = entry('firearms/multi-purpose-launcher');
const shortbow = entry('bows/shortbow');
const greatbow = entry('bows/greatbow');
const repeatingCrossbow = entry('crossbows/repeating-crossbow');
const spinner = entry('crossbows/spinner');
const portableBallista = entry('crossbows/portable-ballista');
const lightCrossbow = entry('crossbows/light-crossbow');
const handCrossbow = entry('crossbows/hand-crossbow');
const battleAxe = entry('axes/battle-axe');

// ---------------------------------------------------------------------------
// Fixture builders
// ---------------------------------------------------------------------------

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function ammoItem(id, { family, ammoId, qty = 20, name = null, type = 'consumable' } = {}) {
  return {
    _id: id,
    id,
    name: name || id,
    type,
    quantity: qty,
    system: {
      quantity: qty,
      type: { value: type === 'consumable' ? 'ammo' : type, subtype: `rme-${family}` },
    },
    flags: { 'foundry-rme': { family, ammoId } },
  };
}

function weaponItem(ammoState = null) {
  const item = { _id: 'weapon', id: 'weapon', system: {} };
  if (ammoState) {
    item.flags = { 'foundry-rme': { ammunition: { ...ammoState } } };
  }
  return item;
}

const rifleCartridge = () =>
  ammoItem('r1', { family: 'rifle', ammoId: 'rifle/rifle-cartridge' });
const matchGradeCartridge = () =>
  ammoItem('m1', { family: 'rifle', ammoId: 'rifle/match-grade-rifle-cartridge' });

// ---------------------------------------------------------------------------
// Ammo-family mapping
// ---------------------------------------------------------------------------

test('ammoFamily maps every Bows entry to arrow (Greatbow stays arrow)', () => {
  assert.equal(ammoFamily(shortbow), 'arrow');
  assert.equal(ammoFamily(greatbow), 'arrow');
  for (const e of equipment) {
    if (e.group === 'Bows') {
      assert.equal(ammoFamily(e), 'arrow', `${e.id} must be arrow`);
    }
  }
});

test('ammoFamily maps Crossbows with the Spinner and Portable Ballista exceptions', () => {
  assert.equal(ammoFamily(lightCrossbow), 'crossbow');
  assert.equal(ammoFamily(repeatingCrossbow), 'crossbow');
  assert.equal(ammoFamily(spinner), 'spinner');
  assert.equal(ammoFamily(portableBallista), 'javelin');
  for (const e of equipment) {
    if (e.group !== 'Crossbows') continue;
    const expected =
      e.name === 'Spinner' ? 'spinner' : e.name === 'Portable Ballista' ? 'javelin' : 'crossbow';
    assert.equal(ammoFamily(e), expected, `${e.id} must map to ${expected}`);
  }
});

test('ammoFamily maps Firearms by exact name and returns null elsewhere', () => {
  assert.equal(ammoFamily(boltActionRifle), 'rifle');
  assert.equal(ammoFamily(leverActionRifle), 'rifle');
  assert.equal(ammoFamily(revolvingCarbine), 'rifle');
  assert.equal(ammoFamily(doubleBarrelledShotgun), 'shotgun');
  assert.equal(ammoFamily(sawedOffShotgun), 'shotgun');
  assert.equal(ammoFamily(breakActionRevolver), 'pistol');
  assert.equal(ammoFamily(handCannon), 'pistol');
  assert.equal(ammoFamily(multiPurposeLauncher), 'mpl');
  assert.equal(ammoFamily(battleAxe), null);
});

test('ammoFamily returns null for every non-amd-weapon catalog entry', () => {
  for (const e of equipment) {
    if (e.group === 'Bows' || e.group === 'Crossbows' || e.group === 'Firearms') continue;
    assert.equal(ammoFamily(e), null, `${e.id} must have no ammo family`);
  }
});

// ---------------------------------------------------------------------------
// Magazine capacity
// ---------------------------------------------------------------------------

test('magazineCapacity: Bolt-Action Rifle reads the Loading parameter at any level', () => {
  assert.equal(magazineCapacity(boltActionRifle, 'untrained'), 4);
  assert.equal(magazineCapacity(boltActionRifle, 'proficient'), 4);
  assert.equal(magazineCapacity(boltActionRifle, 'expert'), 4);
});

test('magazineCapacity: Lever-Action Rifle cap is 8', () => {
  assert.equal(magazineCapacity(leverActionRifle, 'proficient'), 8);
  assert.equal(magazineCapacity(leverActionRifle, 'expert'), 8);
});

test('magazineCapacity: both shotguns cap at 2', () => {
  assert.equal(magazineCapacity(doubleBarrelledShotgun, 'basic'), 2);
  assert.equal(magazineCapacity(sawedOffShotgun, 'basic'), 2);
});

test('magazineCapacity: Repeating Crossbow is 6 and Spinner is 10', () => {
  assert.equal(magazineCapacity(repeatingCrossbow, 'proficient'), 6);
  assert.equal(magazineCapacity(spinner, 'proficient'), 10);
});

test('magazineCapacity: non-magazine weapons are 0 (bows, base crossbows, ballista)', () => {
  assert.equal(magazineCapacity(shortbow, 'proficient'), 0);
  assert.equal(magazineCapacity(lightCrossbow, 'proficient'), 0);
  assert.equal(magazineCapacity(portableBallista, 'proficient'), 0);
});

test('magazineCapacity: Firearm capacity follows tierProperties (Hand Cannon expert drops Loading)', () => {
  assert.equal(magazineCapacity(handCannon, 'untrained'), 3);
  assert.equal(magazineCapacity(handCannon, 'basic'), 3);
  assert.equal(magazineCapacity(handCannon, 'expert'), 0);
});

// ---------------------------------------------------------------------------
// Reload options
// ---------------------------------------------------------------------------

test('reloadOptions: Bolt-Action Rifle expert gains a full action and a single special', () => {
  const options = reloadOptions(boltActionRifle, 'expert');
  assert.equal(options.length, 2);
  const byKey = options.map((o) => `${o.activationType}:${o.mode}`).sort();
  assert.deepEqual(byKey, ['action:full', 'special:single']);

  const single = options.find((o) => o.mode === 'single');
  assert.ok(single, 'expected a single-cartridge option');
  assert.equal(single.activationType, 'special');
  assert.match(single.label, /single cartridge/i);
  assert.match(single.label, /Object Interaction/i);
  assert.equal(single.id, 'special-single');

  const action = options.find((o) => o.activationType === 'action');
  assert.equal(action.mode, 'full');
  assert.equal(action.label, 'Reload (Action)');
});

test('reloadOptions: Bolt-Action Rifle untrained has only the full action (Reload (action) deduped)', () => {
  const options = reloadOptions(boltActionRifle, 'untrained');
  assert.equal(options.length, 1);
  assert.deepEqual(options[0], {
    id: 'action-full',
    label: 'Reload (Action)',
    activationType: 'action',
    mode: 'full',
  });
});

test('reloadOptions: Lever-Action Rifle and shotgun add a special option tier-specifically', () => {
  const lever = reloadOptions(leverActionRifle, 'proficient');
  assert.deepEqual(
    lever.map((o) => `${o.activationType}:${o.mode}`).sort(),
    ['action:full', 'special:single']
  );

  const shotgun = reloadOptions(doubleBarrelledShotgun, 'expert');
  assert.deepEqual(
    shotgun.map((o) => `${o.activationType}:${o.mode}`).sort(),
    ['action:full', 'special:full']
  );
  const attack = shotgun.find((o) => o.activationType === 'special');
  assert.equal(attack.label, 'Reload (Attack)');
});

test('reloadOptions: a magazine weapon always lists a full-action baseline and never duplicates it', () => {
  // Repeating Crossbow has a free tier reload that is surfaced as a separate
  // special option on top of the full-action baseline.
  const options = reloadOptions(repeatingCrossbow, 'proficient');
  const keys = options.map((o) => `${o.activationType}:${o.mode}`);
  assert.ok(keys.includes('action:full'), 'full-action baseline must be present');
  assert.equal(options.filter((o) => o.activationType === 'action' && o.mode === 'full').length, 1);
  assert.ok(keys.includes('special:full'), 'free reload must surface as a special option');
});

test('reloadOptions: non-magazine weapons return no options even when a Reload property exists', () => {
  // Hand Crossbow and Light Crossbow carry a Reload property (free / reaction
  // respectively) yet have no magazine: their ammo stack is consumed directly
  // on each shot, so no reload transfer option may be exposed.
  assert.deepEqual(reloadOptions(handCrossbow, 'proficient'), []);
  assert.deepEqual(reloadOptions(handCrossbow, 'expert'), []);
  assert.deepEqual(reloadOptions(lightCrossbow, 'proficient'), []);
  assert.deepEqual(reloadOptions(shortbow, 'proficient'), []);
});

test('reloadOptions: Repeating Crossbow and Spinner retain capacity and their parsed fast option', () => {
  const repeat = reloadOptions(repeatingCrossbow, 'proficient');
  assert.ok(repeat.some((o) => o.id === 'action-full'), 'full-action baseline must be present');
  assert.ok(repeat.some((o) => o.id === 'special-full'), 'free reload must surface as a special option');

  const spin = reloadOptions(spinner, 'proficient');
  assert.deepEqual(
    spin.map((o) => `${o.activationType}:${o.mode}`).sort(),
    ['action:full', 'special:full']
  );
  const free = spin.find((o) => o.activationType === 'special');
  assert.equal(free.label, 'Reload (Free)');
});

test('reloadOptions: Bolt-Action Rifle expert full+single is unaffected', () => {
  const options = reloadOptions(boltActionRifle, 'expert');
  assert.equal(options.length, 2);
  const byKey = options.map((o) => `${o.activationType}:${o.mode}`).sort();
  assert.deepEqual(byKey, ['action:full', 'special:single']);
});

// ---------------------------------------------------------------------------
// readAmmoState
// ---------------------------------------------------------------------------

test('readAmmoState returns a normalized shape and does not clamp invalid data', () => {
  assert.deepEqual(readAmmoState(weaponItem()), {
    reserveItemId: null,
    loaded: 0,
    loadedAmmoId: null,
  });
  assert.deepEqual(
    readAmmoState(weaponItem({ reserveItemId: 'x', loaded: 3, loadedAmmoId: 'rifle/rifle-cartridge' })),
    { reserveItemId: 'x', loaded: 3, loadedAmmoId: 'rifle/rifle-cartridge' }
  );
  // Invalid stored data (negative / fractional loaded) is surfaced verbatim.
  assert.equal(readAmmoState(weaponItem({ loaded: 7.5 })).loaded, 7.5);
  assert.equal(readAmmoState(weaponItem({ loaded: -2 })).loaded, -2);
});

// ---------------------------------------------------------------------------
// planAssignAmmo
// ---------------------------------------------------------------------------

test('planAssignAmmo is idempotent and only changes the reserve item id', () => {
  const weapon = weaponItem();
  const ammo = rifleCartridge();
  const first = planAssignAmmo(weapon, ammo, boltActionRifle);
  const second = planAssignAmmo(weapon, ammo, boltActionRifle);
  assert.deepEqual(first, second);
  assert.equal(first.weaponState.reserveItemId, 'r1');
  assert.equal(first.weaponState.loaded, 0);
  assert.equal(first.weaponState.loadedAmmoId, null);
});

test('planAssignAmmo preserves loaded ammo and id while swapping the reserve', () => {
  const weapon = weaponItem({
    reserveItemId: 'old',
    loaded: 3,
    loadedAmmoId: 'rifle/rifle-cartridge',
  });
  const newAmmo = ammoItem('new', { family: 'rifle', ammoId: 'rifle/rifle-cartridge' });
  const result = planAssignAmmo(weapon, newAmmo, boltActionRifle);
  assert.equal(result.weaponState.reserveItemId, 'new');
  assert.equal(result.weaponState.loaded, 3);
  assert.equal(result.weaponState.loadedAmmoId, 'rifle/rifle-cartridge');
});

test('planAssignAmmo rejects an incompatible ammo item', () => {
  const weapon = weaponItem();
  const wrong = ammoItem('b', { family: 'crossbow', ammoId: 'crossbow/bolts' });
  assert.throws(() => planAssignAmmo(weapon, wrong, boltActionRifle), /compatible/i);
});

// ---------------------------------------------------------------------------
// planReload
// ---------------------------------------------------------------------------

test('planReload: a full action transfer fills the magazine from the assigned stack', () => {
  const weapon = weaponItem({ reserveItemId: 'r1', loaded: 0, loadedAmmoId: null });
  const ammo = rifleCartridge();
  const result = planReload(weapon, ammo, boltActionRifle, 'expert', 'action-full');
  assert.equal(result.transferred, 4);
  assert.equal(result.weaponState.loaded, 4);
  assert.equal(result.weaponState.loadedAmmoId, 'rifle/rifle-cartridge');
  assert.equal(result.ammoQuantity, 20 - 4);
});

test('planReload: a single-cartridge option transfers only one round', () => {
  const weapon = weaponItem({ reserveItemId: 'r1', loaded: 0, loadedAmmoId: null });
  const ammo = rifleCartridge();
  const result = planReload(weapon, ammo, boltActionRifle, 'expert', 'special-single');
  assert.equal(result.transferred, 1);
  assert.equal(result.weaponState.loaded, 1);
  assert.equal(result.weaponState.loadedAmmoId, 'rifle/rifle-cartridge');
  assert.equal(result.ammoQuantity, 19);
});

test('planReload: a shortage transfers only the rounds that are available', () => {
  const weapon = weaponItem({ reserveItemId: 'r1', loaded: 0, loadedAmmoId: null });
  const ammo = ammoItem('r1', { family: 'rifle', ammoId: 'rifle/rifle-cartridge', qty: 2 });
  const result = planReload(weapon, ammo, boltActionRifle, 'expert', 'action-full');
  assert.equal(result.transferred, 2);
  assert.equal(result.weaponState.loaded, 2);
  assert.equal(result.ammoQuantity, 0);
});

test('planReload: errors when there is nothing to transfer (magazine already full / empty stack)', () => {
  const full = weaponItem({ reserveItemId: 'r1', loaded: 4, loadedAmmoId: 'rifle/rifle-cartridge' });
  const ammo = rifleCartridge();
  assert.throws(
    () => planReload(full, ammo, boltActionRifle, 'expert', 'action-full'),
    /nothing to reload|already full/i
  );

  const empty = ammoItem('r1', { family: 'rifle', ammoId: 'rifle/rifle-cartridge', qty: 0 });
  assert.throws(
    () => planReload(weaponItem({ reserveItemId: 'r1' }), empty, boltActionRifle, 'expert', 'action-full'),
    /compatible|empty/i
  );
});

test('planReload: refuses to silently switch a non-empty magazine to a different ammo id', () => {
  const weapon = weaponItem({
    reserveItemId: 'm1',
    loaded: 2,
    loadedAmmoId: 'rifle/rifle-cartridge',
  });
  const match = matchGradeCartridge();
  assert.throws(
    () => planReload(weapon, match, boltActionRifle, 'expert', 'special-single'),
    /mix|differing/i
  );
});

test('planReload: allows the switch once the magazine is empty', () => {
  const weapon = weaponItem({ reserveItemId: 'm1', loaded: 0, loadedAmmoId: null });
  const match = matchGradeCartridge();
  const result = planReload(weapon, match, boltActionRifle, 'expert', 'special-single');
  assert.equal(result.transferred, 1);
  assert.equal(result.weaponState.loaded, 1);
  assert.equal(result.weaponState.loadedAmmoId, 'rifle/match-grade-rifle-cartridge');
});

test('planReload: validates the assigned reserve stack id', () => {
  const weapon = weaponItem({ reserveItemId: 'r1', loaded: 0, loadedAmmoId: null });
  const other = ammoItem('other', { family: 'rifle', ammoId: 'rifle/rifle-cartridge' });
  assert.throws(
    () => planReload(weapon, other, boltActionRifle, 'expert', 'action-full'),
    /reserve stack/i
  );
});

test('planReload: a non-magazine weapon rejects any reload option', () => {
  // A Hand Crossbow (capacity 0) has no reload transfer to perform, so every
  // option id from reloadOptions is rejected rather than inventoried.
  const hand = weaponItem();
  const bolt = ammoItem('b', { family: 'crossbow', ammoId: 'crossbow/bolts', qty: 20 });
  assert.throws(
    () => planReload(hand, bolt, handCrossbow, 'proficient', 'special-full'),
    /unknown reload option/i
  );
});

test('planReload: rejects an unseen option id and incompatible ammo', () => {
  const weapon = weaponItem({ reserveItemId: 'r1', loaded: 0, loadedAmmoId: null });
  assert.throws(
    () => planReload(weapon, rifleCartridge(), boltActionRifle, 'expert', 'nope'),
    /unknown reload option/i
  );
  const wrong = ammoItem('b', { family: 'crossbow', ammoId: 'crossbow/bolts' });
  assert.throws(
    () => planReload(weapon, wrong, boltActionRifle, 'expert', 'action-full'),
    /compatible/i
  );
});

test('planReload: rejects loaded rounds of unknown identity instead of relabeling them', () => {
  const weapon = weaponItem({
    reserveItemId: 'r1',
    loaded: 2,
    loadedAmmoId: null,
  });
  const ammo = rifleCartridge();
  assert.throws(
    () => planReload(weapon, ammo, boltActionRifle, 'expert', 'action-full'),
    /unknown ammunition|empty it manually|recover the ammo type/i
  );
});

test('planReload: rejects a magazine that exceeds capacity and reports the excess', () => {
  const weapon = weaponItem({
    reserveItemId: 'r1',
    loaded: 5,
    loadedAmmoId: 'rifle/rifle-cartridge',
  });
  const ammo = rifleCartridge();
  assert.throws(
    () => planReload(weapon, ammo, boltActionRifle, 'expert', 'action-full'),
    /excess|capacity/i
  );
});

test('planReload: allows a new ammo type when the magazine is empty (loaded 0)', () => {
  const weapon = weaponItem({
    reserveItemId: 'm1',
    loaded: 0,
    loadedAmmoId: null,
  });
  const match = matchGradeCartridge();
  const result = planReload(weapon, match, boltActionRifle, 'expert', 'action-full');
  assert.equal(result.transferred, 4);
  assert.equal(result.weaponState.loaded, 4);
  assert.equal(result.weaponState.loadedAmmoId, 'rifle/match-grade-rifle-cartridge');
});

test('planReload: still rejects a different ammo type while rounds are loaded', () => {
  const weapon = weaponItem({
    reserveItemId: 'm1',
    loaded: 2,
    loadedAmmoId: 'rifle/rifle-cartridge',
  });
  const match = matchGradeCartridge();
  assert.throws(
    () => planReload(weapon, match, boltActionRifle, 'expert', 'action-full'),
    /mix|different/i
  );
});

// ---------------------------------------------------------------------------
// planShot
// ---------------------------------------------------------------------------

test('planShot: a magazine weapon decrements loaded and never touches the stack', () => {
  const weapon = weaponItem({
    reserveItemId: 'r1',
    loaded: 2,
    loadedAmmoId: 'rifle/rifle-cartridge',
  });
  const ammo = rifleCartridge();
  const shot = planShot(weapon, ammo, boltActionRifle, 'expert');
  assert.deepEqual(shot.weaponState, {
    reserveItemId: 'r1',
    loaded: 1,
    loadedAmmoId: 'rifle/rifle-cartridge',
  });
  assert.equal(shot.ammoQuantity, null);
  assert.equal(shot.ammoId, 'rifle/rifle-cartridge');
});

test('planShot: a depleted magazine errors', () => {
  const weapon = weaponItem({ reserveItemId: 'r1', loaded: 0, loadedAmmoId: 'rifle/rifle-cartridge' });
  assert.throws(() => planShot(weapon, null, boltActionRifle, 'expert'), /empty/i);
});

test('planShot: a deleted reserve stack still allows loaded magazine shots', () => {
  const weapon = weaponItem({
    reserveItemId: 'gone',
    loaded: 2,
    loadedAmmoId: 'rifle/rifle-cartridge',
  });
  // reserveItemId no longer resolves to an actor item; ammoItem is null.
  const shot = planShot(weapon, null, boltActionRifle, 'expert');
  assert.equal(shot.weaponState.loaded, 1);
  assert.equal(shot.weaponState.loadedAmmoId, 'rifle/rifle-cartridge');
  assert.equal(shot.weaponState.reserveItemId, 'gone');
  assert.equal(shot.ammoQuantity, null);
  assert.equal(shot.ammoId, 'rifle/rifle-cartridge');
});

test('planShot: a direct-consumption bow consumes the stack and leaves state unchanged', () => {
  const bow = weaponItem();
  const arrows = ammoItem('arrows', { family: 'arrow', ammoId: 'arrow/arrows', qty: 20 });
  const shot = planShot(bow, arrows, shortbow, 'proficient');
  assert.deepEqual(shot.weaponState, { reserveItemId: null, loaded: 0, loadedAmmoId: null });
  assert.equal(shot.ammoQuantity, 19);
  assert.equal(shot.ammoId, 'arrow/arrows');
});

test('planShot: a Hand Crossbow direct shot decrements the stack by exactly one', () => {
  const hand = weaponItem();
  const bolt = ammoItem('b', { family: 'crossbow', ammoId: 'crossbow/bolts', qty: 20 });
  const shot = planShot(hand, bolt, handCrossbow, 'proficient');
  // No loaded round is invented; the reserve stack is the only count reduced.
  assert.deepEqual(shot.weaponState, { reserveItemId: null, loaded: 0, loadedAmmoId: null });
  assert.equal(shot.ammoQuantity, 19);
  assert.equal(shot.ammoId, 'crossbow/bolts');
});

test('planShot: a javelin-weapon stack is consumed for the Portable Ballista', () => {
  const ballista = weaponItem();
  const javelin = ammoItem('jav', {
    family: 'javelin',
    ammoId: 'javelin',
    qty: 5,
    name: 'Javelin',
    type: 'weapon',
  });
  const shot = planShot(ballista, javelin, portableBallista, 'proficient');
  assert.deepEqual(shot.weaponState, { reserveItemId: null, loaded: 0, loadedAmmoId: null });
  assert.equal(shot.ammoQuantity, 4);
  assert.equal(shot.ammoId, 'javelin');
});

test('planShot: rejects incompatible ammo for a direct-consumption weapon', () => {
  const bow = weaponItem();
  const wrong = ammoItem('b', { family: 'rifle', ammoId: 'rifle/rifle-cartridge' });
  assert.throws(() => planShot(bow, wrong, shortbow, 'proficient'), /compatible/i);
});

// ---------------------------------------------------------------------------
// compatibleAmmo
// ---------------------------------------------------------------------------

test('compatibleAmmo honors the tag, consumable type, and positive quantity', () => {
  assert.ok(compatibleAmmo(boltActionRifle, rifleCartridge()));
  assert.ok(compatibleAmmo(shortbow, ammoItem('a', { family: 'arrow', ammoId: 'arrow/arrows' })));
  assert.ok(compatibleAmmo(portableBallista, ammoItem('j', { family: 'javelin', ammoId: 'javelin', name: 'Javelin', type: 'weapon' })));

  // Empty stack is not compatible.
  assert.equal(
    compatibleAmmo(boltActionRifle, ammoItem('e', { family: 'rifle', ammoId: 'rifle/rifle-cartridge', qty: 0 })),
    false
  );
  // Wrong family tag is not compatible.
  assert.equal(compatibleAmmo(boltActionRifle, ammoItem('c', { family: 'crossbow', ammoId: 'crossbow/bolts' })), false);
  // Not a consumable is not compatible for a normal ammo family.
  assert.equal(compatibleAmmo(boltActionRifle, ammoItem('w', { family: 'rifle', ammoId: 'rifle/rifle-cartridge', type: 'weapon' })), false);
  // A javelin requires the weapon name.
  assert.equal(compatibleAmmo(portableBallista, ammoItem('j', { family: 'javelin', ammoId: 'javelin', name: 'Spear', type: 'weapon' })), false);
});

// ---------------------------------------------------------------------------
// validAmmoIdForFamily
// ---------------------------------------------------------------------------

test('validAmmoIdForFamily honors the exact per-family allowlist', () => {
  assert.ok(validAmmoIdForFamily('rifle/rifle-cartridge', 'rifle'));
  assert.ok(validAmmoIdForFamily('rifle/match-grade-rifle-cartridge', 'rifle'));
  assert.ok(validAmmoIdForFamily('arrow/plus-1-arrows', 'arrow'));
  assert.ok(validAmmoIdForFamily('crossbow/walloping-bolts', 'crossbow'));
  assert.ok(validAmmoIdForFamily('spinner/bladed-disks', 'spinner'));
  assert.ok(validAmmoIdForFamily('shotgun/buckshot', 'shotgun'));
  assert.ok(validAmmoIdForFamily('pistol/masterwork-pistol-cartridge', 'pistol'));
  assert.ok(validAmmoIdForFamily('mpl/mpl-incendiary', 'mpl'));
  assert.ok(validAmmoIdForFamily('javelin', 'javelin'));

  // The family must match exactly, not merely by id prefix.
  assert.equal(validAmmoIdForFamily('arrow/arrows', 'rifle'), false);
  assert.equal(validAmmoIdForFamily('rifle/rifle-cartridge', 'arrow'), false);
  // Unknown ids are rejected.
  assert.equal(validAmmoIdForFamily('arrow/platinum-arrows', 'arrow'), false);
  assert.equal(validAmmoIdForFamily('rifle/not-a-cartridge', 'rifle'), false);
  // A family with no list (or null) rejects everything.
  assert.equal(validAmmoIdForFamily('rifle/rifle-cartridge', null), false);
  assert.equal(validAmmoIdForFamily('javelin', 'rifle'), false);
});

test('validAmmoIdForFamily allowlist matches data/ammunition.json exactly', () => {
  const ammoSource = JSON.parse(
    readFileSync(join(__dirname, '..', 'data', 'ammunition.json'), 'utf8')
  ).ammunition;
  const catalogFamilies = new Set();
  for (const a of ammoSource) {
    assert.ok(
      validAmmoIdForFamily(a.id, a.family),
      `${a.id} must be valid for family ${a.family}`
    );
    catalogFamilies.add(a.family);
  }
  // The hardcoded allowlist covers the exact same seven families and the exact
  // same ids as the catalog; the javelin sentinel is valid only for javelin.
  assert.deepEqual(
    [...catalogFamilies].sort(),
    ['arrow', 'crossbow', 'mpl', 'pistol', 'rifle', 'shotgun', 'spinner']
  );
  assert.equal(ammoSource.length, 25);
  assert.ok(validAmmoIdForFamily('javelin', 'javelin'));
  assert.equal(validAmmoIdForFamily('crossbow/bolts', 'javelin'), false);
});

test('compatibleAmmo rejects a matching family when the ammo id is from another family', () => {
  const wrongId = ammoItem('x', { family: 'arrow', ammoId: 'rifle/rifle-cartridge' });
  assert.equal(compatibleAmmo(shortbow, wrongId), false);
});

test('compatibleAmmo rejects an unknown ammo id for the family', () => {
  const unknown = ammoItem('u', { family: 'arrow', ammoId: 'arrow/platinum-arrows' });
  assert.equal(compatibleAmmo(shortbow, unknown), false);
});

test('compatibleAmmo accepts legitimate variants across families', () => {
  assert.ok(compatibleAmmo(shortbow, ammoItem('a1', { family: 'arrow', ammoId: 'arrow/fire-arrows' })));
  assert.ok(compatibleAmmo(shortbow, ammoItem('a2', { family: 'arrow', ammoId: 'arrow/plus-1-arrows' })));
  assert.ok(compatibleAmmo(repeatingCrossbow, ammoItem('c1', { family: 'crossbow', ammoId: 'crossbow/walloping-bolts' })));
  assert.ok(compatibleAmmo(boltActionRifle, ammoItem('r2', { family: 'rifle', ammoId: 'rifle/match-grade-rifle-cartridge' })));
  assert.ok(compatibleAmmo(boltActionRifle, ammoItem('r3', { family: 'rifle', ammoId: 'rifle/masterwork-rifle-cartridge' })));
  assert.ok(compatibleAmmo(doubleBarrelledShotgun, ammoItem('s1', { family: 'shotgun', ammoId: 'shotgun/buckshot' })));
  assert.ok(compatibleAmmo(breakActionRevolver, ammoItem('p1', { family: 'pistol', ammoId: 'pistol/match-grade-pistol-cartridge' })));
  assert.ok(compatibleAmmo(multiPurposeLauncher, ammoItem('m1', { family: 'mpl', ammoId: 'mpl/mpl-smoke' })));
  assert.ok(compatibleAmmo(spinner, ammoItem('sp1', { family: 'spinner', ammoId: 'spinner/bladed-disks' })));
});

test('planShot: a loaded foreign-family round is rejected even when the reserve is deleted', () => {
  const weapon = weaponItem({ reserveItemId: 'gone', loaded: 2, loadedAmmoId: 'arrow/arrows' });
  assert.throws(() => planShot(weapon, null, boltActionRifle, 'expert'), /incompatible/i);
});

test('planReload: a loaded foreign-family round is rejected', () => {
  const weapon = weaponItem({ reserveItemId: 'r1', loaded: 2, loadedAmmoId: 'arrow/arrows' });
  assert.throws(
    () => planReload(weapon, rifleCartridge(), boltActionRifle, 'expert', 'action-full'),
    /incompatible/i
  );
});

test('planAssignAmmo: rejects a weapon already loaded with foreign ammunition', () => {
  const weapon = weaponItem({ reserveItemId: 'r1', loaded: 2, loadedAmmoId: 'arrow/arrows' });
  assert.throws(() => planAssignAmmo(weapon, rifleCartridge(), boltActionRifle), /incompatible|empty/i);
});

test('planAssignAmmo: accepts a weapon already loaded with a legitimate variant', () => {
  const weapon = weaponItem({
    reserveItemId: 'r1',
    loaded: 2,
    loadedAmmoId: 'rifle/match-grade-rifle-cartridge',
  });
  const result = planAssignAmmo(weapon, rifleCartridge(), boltActionRifle);
  assert.equal(result.weaponState.reserveItemId, 'r1');
  assert.equal(result.weaponState.loaded, 2);
  assert.equal(result.weaponState.loadedAmmoId, 'rifle/match-grade-rifle-cartridge');
});

// ---------------------------------------------------------------------------
// No input mutation
// ---------------------------------------------------------------------------

test('plan* functions never mutate the weapon or ammo item inputs', () => {
  const weapon = weaponItem({
    reserveItemId: 'r1',
    loaded: 1,
    loadedAmmoId: 'rifle/rifle-cartridge',
  });
  const ammo = rifleCartridge();
  const weaponBefore = clone(weapon);
  const ammoBefore = clone(ammo);

  planAssignAmmo(weapon, ammo, boltActionRifle);
  planReload(weapon, ammo, boltActionRifle, 'expert', 'special-single');
  planShot(weapon, ammo, boltActionRifle, 'expert');

  assert.deepEqual(weapon, weaponBefore);
  assert.deepEqual(ammo, ammoBefore);
});

// ---------------------------------------------------------------------------
// Every referenced ammo id exists in the ammunition source (tests may read
// data/ammunition.json; the runtime module never does)
// ---------------------------------------------------------------------------

test('catalog ammo ids used by the tests resolve in data/ammunition.json', () => {
  const ammoSource = JSON.parse(
    readFileSync(join(__dirname, '..', 'data', 'ammunition.json'), 'utf8')
  ).ammunition;
  const ids = new Set(ammoSource.map((a) => a.id));
  for (const ammoId of [
    'rifle/rifle-cartridge',
    'rifle/match-grade-rifle-cartridge',
    'arrow/arrows',
    'crossbow/bolts',
  ]) {
    assert.ok(ids.has(ammoId), `ammunition id ${ammoId} must exist in data/ammunition.json`);
  }
});
