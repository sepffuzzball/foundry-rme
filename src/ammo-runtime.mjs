// Module-managed ammunition runtime for RME Bows / Crossbows / Firearms.
//
// This layer bridges the pure planning functions in ammunition.mjs with the
// live actor items on a Foundry actor. It owns the assignment, reload and shot
// operations (persisting them through a single updateEmbeddedDocuments call per
// operation), the synchronous activity/roll hook gates that prevent firing or
// reloading without valid ammunition, and the game.rme API surface.
//
// There is deliberately NO native dnd5e `amm` weapon property used, so dnd5e
// never decrements an ammo stack on its own: every ammo change here is the only
// change. No native double-consumption can occur.
//
// Concurrency model: all mutations for one actor are serialized through a
// per-actor promise chain. Each operation re-reads the actor items immediately
// before it mutates and revalidates the plan against that fresh state. This
// closes the same-client stale-write window (a local macro cannot enqueue a
// second spend while a first is still in flight and read a stale quantity).
//
// Cross-client race limitation (documented): the per-actor promise queue above
// serializes mutations only for this one client. It does NOT coordinate with
// any other client. Foundry's updateEmbeddedDocuments does not provide a
// verified compare-and-swap guarantee for the fields written here, so two
// clients can interleave document updates for the same actor: a concurrent
// client that read stale ammunition state writes a stale patch and may
// overwrite another client's quantity or loaded count. Rounds are not safely
// reconciled across clients. This is accepted because ammunition is a
// per-actor convenience, not an economy-critical ledger.

import {
  ammoFamily,
  compatibleAmmo,
  magazineCapacity,
  reloadOptions,
  readAmmoState,
  planAssignAmmo,
  planReload,
  planShot,
} from './ammunition.mjs';
import { computeActorTraining } from './actor-training.mjs';

const ID = 'foundry-rme';

// ---------------------------------------------------------------------------
// Local state
// ---------------------------------------------------------------------------

// Per-actor promise tail. An operation for an actor chains after the previous
// tail so mutations for one actor never interleave on this client.
const actorOperationQueues = new Map();

// In-flight local shot reservations: `${actorId}:${weaponId}` -> count. A
// reservation is taken when a supported attack is rolled and released once the
// queued spend settles, so a rapid sequence of attacks does not over-fire past
// the remaining ammunition before the persisted decrements land.
const reservations = new Map();

// Exact-match shot reservations keyed by roll object identity. `handleRollAttack`
// records a reservation only for the specific roll object that fired; a post
// roll spend is emitted ONLY when `handlePostRollAttack` sees that exact roll
// object for the same actor+weapon. This prevents a phantom spend when the post
// hook fires without a prior matching rollAttack reservation (e.g. the attack
// was canceled, or the post hook fires for a roll that was never reserved).
const rollReservations = new WeakMap();

let catalogWarningIssued = false;

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

const catalogIdOf = (item) => item?.flags?.[ID]?.catalogId ?? null;

function isTaggedWeapon(item) {
  return Boolean(item && item.type === 'weapon' && catalogIdOf(item));
}

function findEntry(equipment, catalogId) {
  if (!equipment || !catalogId) return null;
  if (!Array.isArray(equipment)) return null;
  return equipment.find((e) => e && e.id === catalogId) || null;
}

// The catalog entry for a supported module-managed ammo weapon, or null when
// the item is untagged, unknown or not an ammo weapon.
function supportedWeaponEntry(equipment, item) {
  const entry = findEntry(equipment, catalogIdOf(item));
  if (!entry || ammoFamily(entry) == null) return null;
  return entry;
}

function itemQuantity(item) {
  if (!item || typeof item !== 'object') return 0;
  const sys = item.system?.quantity;
  const top = item.quantity;
  const raw = sys !== undefined && sys !== null ? sys : top !== undefined && top !== null ? top : 0;
  const n = Number(raw);
  return Number.isFinite(n) ? Math.max(0, Math.floor(n)) : 0;
}

function resolveActorItem(actor, id) {
  if (!actor?.items || !id) return null;
  const get = actor.items.get;
  if (typeof get === 'function') return get.call(actor.items, id) || null;
  if (Array.isArray(actor.items)) return actor.items.find((i) => (i._id ?? i.id) === id) || null;
  return null;
}

function iterItems(actor) {
  const items = actor?.items;
  if (Array.isArray(items)) return items;
  if (items && typeof items[Symbol.iterator] === 'function') return [...items];
  return [];
}

function itemId(item) {
  return item?._id ?? item?.id ?? null;
}

function weaponItemId(item) {
  return item?.id ?? item?._id ?? null;
}

// The effective training level for a weapon, defaulting to 'untrained' when the
// actor training cannot be computed (missing flags, missing actor methods).
function effectiveLevel(actor, entry, equipment) {
  try {
    const picture = computeActorTraining(actor, equipment);
    return picture.effective?.items?.[entry.id] ?? 'untrained';
  } catch {
    return 'untrained';
  }
}

function reservationKey(actor, weaponId) {
  return `${actor?.id ?? '?'}:${weaponId}`;
}

// ---------------------------------------------------------------------------
// Notification / warning helpers
// ---------------------------------------------------------------------------

function notifyError(error) {
  console.error(`[${ID}]`, error);
  const message = error?.message || String(error);
  globalThis.ui?.notifications?.error?.(message);
}

function notifyWarn(error) {
  const message = error?.message || String(error);
  globalThis.ui?.notifications?.warn?.(message);
}

function warnCatalogUnavailable() {
  if (catalogWarningIssued) return;
  catalogWarningIssued = true;
  console.warn(`[${ID}] RME catalog is not loaded yet; RME ammunition checks are skipped.`);
}

// ---------------------------------------------------------------------------
// Patch / update helpers
// ---------------------------------------------------------------------------

function weaponPatch(weaponId, weaponState) {
  return { _id: weaponId, [`flags.${ID}.ammunition`]: weaponState };
}

function ammoPatch(ammoItemId, remaining) {
  return { _id: ammoItemId, 'system.quantity': remaining };
}

async function applyItemPatches(actor, patches) {
  if (!Array.isArray(patches) || patches.length === 0) return;
  await actor.updateEmbeddedDocuments('Item', patches);
}

// Inject an item patch into the native consumption updates, merging with an
// existing entry for the same item id rather than duplicating it.
function pushItemPatch(updates, patch) {
  if (!updates || !Array.isArray(updates.item)) return;
  const existing = updates.item.find((u) => u._id === patch._id);
  if (existing) Object.assign(existing, patch);
  else updates.item.push(patch);
}

// ---------------------------------------------------------------------------
// Per-actor operation serialization
// ---------------------------------------------------------------------------

function enqueueActorOperation(actor, task) {
  const id = actor?.id;
  if (!id) return task();
  const prior = actorOperationQueues.get(id) || Promise.resolve();
  const run = prior.catch(() => {}).then(() => task());
  let tail;
  tail = run.then(
    () => { if (actorOperationQueues.get(id) === tail) actorOperationQueues.delete(id); },
    () => { if (actorOperationQueues.get(id) === tail) actorOperationQueues.delete(id); }
  );
  actorOperationQueues.set(id, tail);
  return run;
}

function assertOwner(actor) {
  if (!actor?.isOwner) throw new Error('Actor ownership is required to manage ammunition.');
}

// Resolve the weapon item and its catalog entry. Throws when the item is
// missing, untagged, or not a module-managed ammo weapon.
function resolveWeaponEntry(actor, weaponId, equipment) {
  const weapon = resolveActorItem(actor, weaponId);
  if (!weapon) throw new Error(`Weapon item not found: ${weaponId}.`);
  const entry = findEntry(equipment, catalogIdOf(weapon));
  if (!entry) throw new Error(`Weapon ${weapon.name || weaponId} is not an RME catalog item.`);
  if (ammoFamily(entry) == null) {
    throw new Error(`Weapon ${weapon.name || weaponId} does not consume managed ammunition.`);
  }
  return { weapon, entry };
}

// ---------------------------------------------------------------------------
// Core operations (each persists through one updateEmbeddedDocuments call)
// ---------------------------------------------------------------------------

// Assign an ammo item as the weapon's reserve. Only a compatible ammo item is
// accepted. Returns the normalized ammo state descriptor.
export async function assignActorAmmo(actor, weaponId, ammoItemId, equipment) {
  return enqueueActorOperation(actor, async () => {
    assertOwner(actor);
    const { weapon, entry } = resolveWeaponEntry(actor, weaponId, equipment);
    const ammoItem = resolveActorItem(actor, ammoItemId);
    if (!ammoItem) throw new Error(`Ammunition item not found: ${ammoItemId}.`);
    const { weaponState } = planAssignAmmo(weapon, ammoItem, entry);
    await applyItemPatches(actor, [weaponPatch(weaponItemId(weapon), weaponState)]);
    return getAmmoState(actor, weaponId, equipment);
  });
}

// Reload the weapon from its assigned reserve stack using a named option.
// Returns the normalized ammo state descriptor.
export async function reloadActorAmmo(actor, weaponId, optionId, equipment) {
  return enqueueActorOperation(actor, async () => {
    assertOwner(actor);
    const { weapon, entry } = resolveWeaponEntry(actor, weaponId, equipment);
    const level = effectiveLevel(actor, entry, equipment);
    const state = readAmmoState(weapon);
    const ammoItem = state.reserveItemId ? resolveActorItem(actor, state.reserveItemId) : null;
    const { weaponState, ammoQuantity } = planReload(weapon, ammoItem, entry, level, optionId);
    const patches = [weaponPatch(weaponItemId(weapon), weaponState)];
    if (ammoItem) patches.push(ammoPatch(itemId(ammoItem), ammoQuantity));
    await applyItemPatches(actor, patches);
    return getAmmoState(actor, weaponId, equipment);
  });
}

// Spend one shot. A magazine weapon decrements the loaded rounds only; a
// direct-consumption weapon decrements its reserve stack by exactly one. Never
// decrements both (no double spend). Returns the normalized ammo state
// descriptor.
export async function spendActorShot(actor, weaponId, equipment) {
  return enqueueActorOperation(actor, async () => {
    assertOwner(actor);
    const { weapon, entry } = resolveWeaponEntry(actor, weaponId, equipment);
    const level = effectiveLevel(actor, entry, equipment);
    const capacity = magazineCapacity(entry, level);
    const state = readAmmoState(weapon);
    const ammoItem = state.reserveItemId ? resolveActorItem(actor, state.reserveItemId) : null;
    const shot = planShot(weapon, ammoItem, entry, level);
    const patches = [];
    if (capacity > 0) {
      patches.push(weaponPatch(weaponItemId(weapon), shot.weaponState));
    } else if (ammoItem && shot.ammoQuantity != null) {
      patches.push(ammoPatch(itemId(ammoItem), shot.ammoQuantity));
    }
    await applyItemPatches(actor, patches);
    return getAmmoState(actor, weaponId, equipment);
  });
}

// ---------------------------------------------------------------------------
// Ammo state query
// ---------------------------------------------------------------------------

// Read the normalized state for a weapon and any compatible ammo items on the
// actor, plus the magazine capacity and reload options at the effective tier.
export function getAmmoState(actor, weaponId, equipment) {
  const weapon = resolveActorItem(actor, weaponId);
  if (!weapon) {
    return { state: readAmmoState(null), compatibleItems: [], capacity: 0, options: [] };
  }
  const empty = { state: readAmmoState(weapon), compatibleItems: [], capacity: 0, options: [] };
  const entry = findEntry(equipment, catalogIdOf(weapon));
  if (!entry || ammoFamily(entry) == null) return empty;
  const level = effectiveLevel(actor, entry, equipment);
  const compatibleItems = iterItems(actor)
    .filter((i) => compatibleAmmo(entry, i))
    .map((i) => ({
      id: itemId(i),
      name: i.name,
      quantity: itemQuantity(i),
      ammoId: i.flags?.[ID]?.ammoId ?? null,
    }));
  return {
    state: readAmmoState(weapon),
    compatibleItems,
    capacity: magazineCapacity(entry, level),
    options: reloadOptions(entry, level),
  };
}

// ---------------------------------------------------------------------------
// Reload activity gates
// ---------------------------------------------------------------------------

const isReloadUtilityActivity = (activity) =>
  Boolean(activity && activity.type === 'utility' && activity.flags?.[ID]?.reloadOptionId);

// Resolve the current weapon document for an activity, preferring the actor's
// live embedded item over the activity's cloned item.
function currentWeaponItem(actor, item) {
  const resolved = resolveActorItem(actor, item?.id ?? item?._id);
  return resolved ?? item;
}

// Synchronous filter for `dnd5e.preUseActivity`: gate ONLY a reload utility
// activity flagged with the module reload option id on an actor-owned tagged
// RME weapon. On an invalid assigned stack/level planReload fails and the use
// is canceled with a warning. Every other activity is untouched.
export function handlePreUseActivity(activity, usageConfig, dialogConfig, messageConfig, equipment) {
  if (!isReloadUtilityActivity(activity)) return true;
  if (equipment == null) {
    warnCatalogUnavailable();
    return true;
  }
  const actor = activity?.actor;
  const item = activity?.item;
  if (!actor?.isOwner) return true;
  if (!isTaggedWeapon(item)) return true;
  const entry = supportedWeaponEntry(equipment, item);
  if (!entry) return true;
  const weapon = currentWeaponItem(actor, item);
  const level = effectiveLevel(actor, entry, equipment);
  const optionId = activity.flags?.[ID]?.reloadOptionId;
  const state = readAmmoState(weapon);
  const ammoItem = state.reserveItemId ? resolveActorItem(actor, state.reserveItemId) : null;
  try {
    planReload(weapon, ammoItem, entry, level, optionId);
    return true;
  } catch (error) {
    notifyWarn(error);
    return false;
  }
}

// Synchronous handler for `dnd5e.activityConsumption`: for the same flagged
// reload utility, revalidate via planReload and inject the weapon and ammo
// patches into `updates.item`. The reload is NOT double-run here - the native
// consumption flow applies the injected item updates. Returns false (and warns)
// only when the reload is invalid.
export function handleActivityConsumption(activity, usageConfig, messageConfig, updates, equipment) {
  if (!isReloadUtilityActivity(activity)) return true;
  if (equipment == null) {
    warnCatalogUnavailable();
    return true;
  }
  const actor = activity?.actor;
  const item = activity?.item;
  if (!actor?.isOwner) return true;
  if (!isTaggedWeapon(item)) return true;
  const entry = supportedWeaponEntry(equipment, item);
  if (!entry) return true;
  const weapon = currentWeaponItem(actor, item);
  const level = effectiveLevel(actor, entry, equipment);
  const optionId = activity.flags?.[ID]?.reloadOptionId;
  const state = readAmmoState(weapon);
  const ammoItem = state.reserveItemId ? resolveActorItem(actor, state.reserveItemId) : null;
  try {
    const { weaponState, ammoQuantity } = planReload(weapon, ammoItem, entry, level, optionId);
    pushItemPatch(updates, weaponPatch(weaponItemId(weapon), weaponState));
    if (ammoItem) pushItemPatch(updates, ammoPatch(itemId(ammoItem), ammoQuantity));
    return true;
  } catch (error) {
    notifyWarn(error);
    return false;
  }
}

// ---------------------------------------------------------------------------
// Attack gates
// ---------------------------------------------------------------------------

// Assert that a shot is feasible accounting for in-flight local shot
// reservations. Throws when there is no compatible, non-empty ammunition.
function assertShotFeasible(actor, weapon, entry, level) {
  const capacity = magazineCapacity(entry, level);
  const reserved = reservations.get(reservationKey(actor, weaponItemId(weapon))) || 0;
  const current = readAmmoState(weapon);
  const ammoItem = current.reserveItemId ? resolveActorItem(actor, current.reserveItemId) : null;

  if (capacity > 0) {
    const fragment = {
      ...weapon,
      flags: {
        ...(weapon.flags || {}),
        [ID]: {
          ...(weapon.flags?.[ID] || {}),
          ammunition: { ...current, loaded: Math.max(0, current.loaded - reserved) },
        },
      },
    };
    planShot(fragment, ammoItem, entry, level);
    return;
  }

  const quantity = itemQuantity(ammoItem);
  const effective = Math.max(0, quantity - reserved);
  const ammoFragment = ammoItem
    ? { ...ammoItem, quantity: effective, system: { ...(ammoItem.system || {}), quantity: effective } }
    : null;
  planShot(weapon, ammoFragment, entry, level);
}

function isMeleeMode(mode) {
  return Boolean(mode && String(mode).startsWith('melee'));
}

// Synchronous filter for `dnd5e.postAttackRollConfiguration`: applied ONLY to an
// attack activity on a tagged supported RME weapon, and skipped for melee
// attack modes. When there is no assigned/compatible ammunition it blocks the
// roll (warn, return false), otherwise it allows it. Only the attack activity is
// affected; every other roll proceeds.
export function handlePostAttackRollConfiguration(rolls, config, dialog, message, equipment) {
  if (equipment == null) {
    warnCatalogUnavailable();
    return true;
  }
  const activity = config?.subject;
  if (!activity || activity.type !== 'attack') return true;
  const actor = activity?.actor;
  const item = activity?.item;
  if (!actor?.isOwner) return true;
  if (!isTaggedWeapon(item)) return true;
  const entry = supportedWeaponEntry(equipment, item);
  if (!entry) return true;
  const mode = rolls?.[0]?.options?.attackMode ?? config?.attackMode;
  if (isMeleeMode(mode)) return true;
  const level = effectiveLevel(actor, entry, equipment);
  const weapon = currentWeaponItem(actor, item);
  try {
    assertShotFeasible(actor, weapon, entry, level);
    return true;
  } catch (error) {
    notifyWarn(error);
    return false;
  }
}

// `dnd5e.rollAttack`: for a valid supported non-melee shot, take an in-flight
// reservation so later configuration still counts the pending shot.
export function handleRollAttack(rolls, data, equipment) {
  if (equipment == null) {
    warnCatalogUnavailable();
    return;
  }
  const activity = data?.subject;
  if (!activity || activity.type !== 'attack') return;
  const actor = activity?.actor;
  const item = activity?.item;
  if (!actor?.isOwner) return;
  if (!isTaggedWeapon(item)) return;
  const entry = supportedWeaponEntry(equipment, item);
  if (!entry) return;
  const roll = rolls?.[0];
  if (!roll || typeof roll !== 'object') return;
  const mode = roll.options?.attackMode ?? activity.item?.system?.attackModes?.[0]?.value;
  if (isMeleeMode(mode)) return;
  // Reserve only once per roll identity. A duplicate rollAttack for the same
  // roll object must not over-reserve the pending-shot count.
  if (rollReservations.has(roll)) return;
  rollReservations.set(roll, { actorId: actor.id, weaponId: weaponItemId(item), mode });
  const key = reservationKey(actor, weaponItemId(item));
  reservations.set(key, (reservations.get(key) || 0) + 1);
}

// `dnd5e.postRollAttack`: enqueue the ammunition spend and release the shot
// reservation once the spend settles, notifying on failure.
export function handlePostRollAttack(rolls, data, equipment) {
  if (equipment == null) {
    warnCatalogUnavailable();
    return;
  }
  const activity = data?.subject;
  if (!activity || activity.type !== 'attack') return;
  const actor = activity?.actor;
  const item = activity?.item;
  if (!actor?.isOwner) return;
  if (!isTaggedWeapon(item)) return;
  const entry = supportedWeaponEntry(equipment, item);
  if (!entry) return;
  const roll = rolls?.[0];
  if (!roll || typeof roll !== 'object') return;
  const mode = roll.options?.attackMode;
  if (isMeleeMode(mode)) return;
  const weaponId = weaponItemId(item);
  // Spend only for the exact roll object reserved by a prior rollAttack on the
  // same actor+weapon. Delete synchronously so a duplicate post hook for the
  // same roll cannot spend a second time.
  const reservation = rollReservations.get(roll);
  if (!reservation || reservation.actorId !== actor.id || reservation.weaponId !== weaponId) return;
  rollReservations.delete(roll);
  const key = reservationKey(actor, weaponId);
  spendActorShot(actor, weaponId, equipment)
    .catch(notifyError)
    .finally(() => {
      const current = reservations.get(key) || 0;
      if (current > 1) reservations.set(key, current - 1);
      else reservations.delete(key);
    });
}

// ---------------------------------------------------------------------------
// game.rme API builder
// ---------------------------------------------------------------------------

// Build an API object bound to a fixed equipment list. Each method reads/calls
// the live actor and never mutates its inputs.
export function createAmmoApi(equipment) {
  return {
    assignAmmo: (actor, weaponId, ammoItemId) => assignActorAmmo(actor, weaponId, ammoItemId, equipment),
    reloadAmmo: (actor, weaponId, optionId) => reloadActorAmmo(actor, weaponId, optionId, equipment),
    getAmmoState: (actor, weaponId) => getAmmoState(actor, weaponId, equipment),
  };
}
