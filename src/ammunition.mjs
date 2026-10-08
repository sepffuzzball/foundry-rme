// Pure, browser-safe ammunition compatibility and magazine state for RME
// module-managed Bows / Crossbows / Firearms.
//
// This module has no Foundry globals and no filesystem access, so it is safe
// to load in the Foundry runtime (browser-like) as well as under Node for
// tests. It only reads data passed to it, and never mutates its inputs. Every
// plan* function returns a new weapon state object plus any ammo-stack
// adjustment, leaving the caller to persist the result.
//
// Native dnd5e ammunition consumption is NOT used. A weapon's ammo is tracked
// through flags['foundry-rme'].ammunition = { reserveItemId, loaded,
// loadedAmmoId } and, for direct-consumption weapons, by decrementing the
// selected ammo stack's quantity. There is no action-economy enforcement here:
// reloadOptions merely describes what a reload costs and whether it loads a
// single cartridge or a full magazine.

import { tierProperties } from './rme-metadata.mjs';

const FLAGS_KEY = 'foundry-rme';
const JAVELIN_AMMO_ID = 'javelin';

// The catalog ammo ids valid for each ammo family, hardcoded so the Foundry
// runtime does not have to load data/ammunition.json. Each set is an exact
// allowlist: an ammo id is acceptable only when it is a member of its family's
// set. Kept in sync with data/ammunition.json; the tests assert the two match
// exactly.
const AMMO_IDS_BY_FAMILY = new Map([
  ['arrow', new Set([
    'arrow/arrows',
    'arrow/fire-arrows',
    'arrow/ice-arrows',
    'arrow/poison-arrows',
    'arrow/shock-arrows',
    'arrow/acid-arrows',
    'arrow/thunder-arrows',
    'arrow/plus-1-arrows',
  ])],
  ['crossbow', new Set([
    'crossbow/bolts',
    'crossbow/walloping-bolts',
    'crossbow/goading-bolts',
    'crossbow/plus-1-bolts',
  ])],
  ['spinner', new Set([
    'spinner/bladed-disks',
  ])],
  ['rifle', new Set([
    'rifle/rifle-cartridge',
    'rifle/match-grade-rifle-cartridge',
    'rifle/masterwork-rifle-cartridge',
  ])],
  ['shotgun', new Set([
    'shotgun/slugs',
    'shotgun/buckshot',
  ])],
  ['pistol', new Set([
    'pistol/pistol-cartridge',
    'pistol/match-grade-pistol-cartridge',
    'pistol/masterwork-pistol-cartridge',
  ])],
  ['mpl', new Set([
    'mpl/mpl-grenade',
    'mpl/mpl-smoke',
    'mpl/mpl-flashbang',
    'mpl/mpl-incendiary',
  ])],
  ['javelin', new Set([JAVELIN_AMMO_ID])],
]);

// Whether an ammo id belongs to a family's exact catalog allowlist. Unknown
// ids (or a family without a list) are rejected. Pure: never mutates and never
// reads the filesystem, so it is safe in the Foundry runtime.
export function validAmmoIdForFamily(ammoId, family) {
  const ids = AMMO_IDS_BY_FAMILY.get(family);
  return ids ? ids.has(ammoId) : false;
}

// ---------------------------------------------------------------------------
// Family mapping
// ---------------------------------------------------------------------------

// Every Bow in the catalog launches arrows, including the Greatbow (its javelin
// / ballista-bolt alternate is a manual choice, not a different ammo family).
const CROSSBOW_FAMILY_EXCEPTIONS = new Map([
  ['Spinner', 'spinner'],
  ['Portable Ballista', 'javelin'],
]);

const FIREARM_FAMILY_BY_NAME = new Map([
  ['Bolt-Action Rifle', 'rifle'],
  ['Lever-Action Rifle', 'rifle'],
  ['Revolving Carbine', 'rifle'],
  ['Double-Barrelled Shotgun', 'shotgun'],
  ['Sawed-Off Shotgun', 'shotgun'],
  ['Break-Action Revolver', 'pistol'],
  ['Hand Cannon', 'pistol'],
  ['Multi-Purpose Launcher', 'mpl'],
]);

// The ammunition family a catalog weapon consumes: 'arrow', 'crossbow',
// 'spinner', 'javelin', 'rifle', 'shotgun', 'pistol', or 'mpl'. Returns null
// for a weapon (or any entry) that is not a module-managed ammo weapon.
export function ammoFamily(entry) {
  if (!entry || typeof entry !== 'object') return null;
  const group = entry.group;
  if (group === 'Bows') return 'arrow';
  if (group === 'Crossbows') {
    return CROSSBOW_FAMILY_EXCEPTIONS.get(entry.name) || 'crossbow';
  }
  if (group === 'Firearms') {
    return FIREARM_FAMILY_BY_NAME.get(entry.name) || null;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Ammo stack shape
// ---------------------------------------------------------------------------

// A stack quantity is a count, so it is normalized to a nonnegative integer.
// System quantity is authoritative; a top-level quantity is accepted only as a
// fallback for test fixtures that do not carry a system block.
function itemQuantity(item) {
  if (!item || typeof item !== 'object') return 0;
  const sys = item.system?.quantity;
  const top = item.quantity;
  const raw =
    sys !== undefined && sys !== null
      ? sys
      : top !== undefined && top !== null
        ? top
        : 0;
  const n = Number(raw);
  return Number.isFinite(n) ? Math.max(0, Math.floor(n)) : 0;
}

function itemId(item) {
  if (!item || typeof item !== 'object') return null;
  return item._id ?? item.id ?? null;
}

// The catalog ammo id of an actor item. For a javelin the ammo id is the fixed
// 'javelin' sentinel (not a catalog ammo entry id); for every consumable ammo
// stack it is the ammoId preserved on the item's flags, never its actor id.
function ammoIdOf(actorItem, entry) {
  if (ammoFamily(entry) === 'javelin') return JAVELIN_AMMO_ID;
  return actorItem?.flags?.[FLAGS_KEY]?.ammoId ?? null;
}

// ---------------------------------------------------------------------------
// Compatibility
// ---------------------------------------------------------------------------

// Whether an actor item is acceptable ammunition for an entry. For the
// Portable Ballista (family 'javelin') the only accepted ammo is an
// actor-owned weapon item named exactly "Javelin" (case-insensitive) with a
// positive quantity. For every other family, the actor item must be a
// consumable carrying the matching flags['foundry-rme'].family tag, a positive
// quantity, and an ammoId that is valid for that family.
export function compatibleAmmo(entry, actorItem) {
  const family = ammoFamily(entry);
  if (family === null) return false;
  if (!actorItem || typeof actorItem !== 'object') return false;

  if (family === 'javelin') {
    return (
      actorItem.type === 'weapon' &&
      String(actorItem.name || '').trim().toLowerCase() === 'javelin' &&
      itemQuantity(actorItem) > 0
    );
  }

  return (
    actorItem.type === 'consumable' &&
    itemQuantity(actorItem) > 0 &&
    actorItem.flags?.[FLAGS_KEY]?.family === family &&
    validAmmoIdForFamily(ammoIdOf(actorItem, entry), family)
  );
}

// ---------------------------------------------------------------------------
// Magazine capacity
// ---------------------------------------------------------------------------

// The magazine capacity of an entry at a level. Firearms read the numeric
// Loading parameter through tierProperties at that level (so a tier that drops
// the Loading property yields 0). Crossbows are fixed by name: Repeating
// Crossbow holds 6, Spinner holds 10, and every other crossbow (including the
// Portable Ballista, which loads a single javelin) is 0. Everything else is 0.
export function magazineCapacity(entry, level = 'proficient') {
  if (!entry || typeof entry !== 'object') return 0;

  if (entry.group === 'Crossbows') {
    if (entry.name === 'Repeating Crossbow') return 6;
    if (entry.name === 'Spinner') return 10;
    return 0;
  }

  if (entry.group === 'Firearms') {
    const props = tierProperties(entry, level);
    const loading = props.find((p) => p.label === 'Loading');
    if (!loading) return 0;
    const n = Number(loading.parameter);
    return Number.isFinite(n) && n >= 0 ? n : 0;
  }

  return 0;
}

// ---------------------------------------------------------------------------
// Reload options
// ---------------------------------------------------------------------------

// The balanced parenthesized content of the first parenthesized group in text,
// or null when there is none. Nested parentheses are handled.
function balancedParenContent(text) {
  const start = text.indexOf('(');
  if (start === -1) return null;
  let depth = 0;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (c === '(') {
      depth += 1;
    } else if (c === ')') {
      depth -= 1;
      if (depth === 0) return text.slice(start + 1, i);
    }
  }
  return text.slice(start + 1);
}

// Parse the activation and single/magazine mode from a Reload property's raw
// token. The raw token is like "Reload (Object Interaction (single
// cartridge))", "Reload (Action)", "Reload (Attack)", or the terse crossbow
// forms "Reload free", "Reload attack", "Reload bonus", "Reload reaction".
function parseReload(raw) {
  const body = String(raw || '').replace(/^Reload\b/i, '').trim();
  let activationRaw;
  const paren = balancedParenContent(body);
  activationRaw = paren !== null ? paren.trim() : body;

  let single = false;
  if (/\(single\s+cartridge\)/i.test(activationRaw)) {
    single = true;
    activationRaw = activationRaw
      .replace(/\s*\(single\s+cartridge\)\s*$/i, '')
      .trim();
  }

  return { activation: activationRaw.toLowerCase(), single };
}

const ACTIVATION_TYPE_MAP = new Map([
  ['object interaction', 'special'],
  ['attack', 'special'],
  ['free', 'special'],
]);

// Map a parsed activation to a Foundry activation type. Object interaction,
// attack, and free have no native activation type, so they map to 'special';
// action, bonus, and reaction are native valid activation types.
function activationTypeOf(activation) {
  return ACTIVATION_TYPE_MAP.get(activation) || activation;
}

const ACTIVATION_DISPLAY = new Map([
  ['action', 'Action'],
  ['bonus', 'Bonus'],
  ['reaction', 'Reaction'],
  ['attack', 'Attack'],
  ['object interaction', 'Object Interaction'],
  ['free', 'Free'],
  ['special', 'Special'],
]);

function activationDisplay(activation) {
  return ACTIVATION_DISPLAY.get(activation) || activation;
}

function optionLabel(activation, single) {
  const base = `Reload (${activationDisplay(activation)}`;
  return single ? `${base} (single cartridge))` : `${base})`;
}

function makeOption(activation, mode, activationType, single) {
  return {
    id: `${activationType}-${mode}`,
    label: optionLabel(activation, single),
    activationType,
    mode,
  };
}

const DEFAULT_FULL_OPTION = {
  id: 'action-full',
  label: 'Reload (Action)',
  activationType: 'action',
  mode: 'full',
};

// Reload options for an entry at a level. A non-magazine weapon (capacity 0)
// consumes its ammo stack directly on each shot, so there is no reload transfer
// to expose: return no options even when a tier carries a Reload property. When
// the entry has a magazine capacity, the plain full-action reload is always
// present. A faster tier-specific Reload property is then appended when it is
// not identical to a full action (same activation type and same full mode).
// Object interaction, attack, and free activations surface as 'special'
// activation type; a raw "(single cartridge)" makes the option mode 'single',
// otherwise it is 'full'.
export function reloadOptions(entry, level = 'proficient') {
  const capacity = magazineCapacity(entry, level);
  if (capacity <= 0) return [];

  const options = [{ ...DEFAULT_FULL_OPTION }];

  const props = tierProperties(entry, level);
  const reload = props.find((p) => p.label === 'Reload');
  if (reload) {
    const { activation, single } = parseReload(reload.raw);
    const activationType = activationTypeOf(activation);
    const mode = single ? 'single' : 'full';
    const option = makeOption(activation, mode, activationType, single);
    const duplicate = options.some(
      (o) => o.activationType === option.activationType && o.mode === option.mode
    );
    if (!duplicate) options.push(option);
  }

  return options;
}

// ---------------------------------------------------------------------------
// Ammo state
// ---------------------------------------------------------------------------

// Read the normalized { reserveItemId, loaded, loadedAmmoId } ammo state from
// flags['foundry-rme'].ammunition. Missing keys default to null / 0, but the
// stored values are returned verbatim: invalid data is NOT silently clamped
// here. Clamping happens only when a plan* function produces a new state.
export function readAmmoState(weapon) {
  const raw = weapon?.flags?.[FLAGS_KEY]?.ammunition;
  return {
    reserveItemId: raw?.reserveItemId ?? null,
    loaded: raw?.loaded ?? 0,
    loadedAmmoId: raw?.loadedAmmoId ?? null,
  };
}

function toInt(value) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.floor(n) : 0;
}

function nonNegativeInt(value) {
  return Math.max(0, toInt(value));
}

// ---------------------------------------------------------------------------
// Plans (return new state; never mutate)
// ---------------------------------------------------------------------------

// Assign an ammo stack as the weapon's reserve, preserving the existing loaded
// count and loaded ammo id. Only a compatible ammo item is accepted.
export function planAssignAmmo(weapon, ammoItem, entry) {
  if (!compatibleAmmo(entry, ammoItem)) {
    throw new Error(`Ammunition is not compatible with ${entry?.name || 'this weapon'}.`);
  }
  const current = readAmmoState(weapon);
  const loaded = nonNegativeInt(current.loaded);
  if (loaded > 0 && !validAmmoIdForFamily(current.loadedAmmoId, ammoFamily(entry))) {
    throw new Error(
      'The weapon is loaded with ammunition incompatible with this weapon; empty it before assigning new ammo.'
    );
  }
  const weaponState = {
    reserveItemId: itemId(ammoItem),
    loaded,
    loadedAmmoId: current.loadedAmmoId,
  };
  return { weaponState };
}

// Plan a reload from an ammo stack into the weapon, returning the new weapon
// state, the remaining stack quantity, and the number transferred. The inputs
// are never mutated. The optionId must name one of reloadOptions(entry, level).
export function planReload(
  weapon,
  ammoItem,
  entry,
  level = 'proficient',
  optionId
) {
  if (!compatibleAmmo(entry, ammoItem)) {
    throw new Error(`Ammunition is not compatible with ${entry?.name || 'this weapon'}.`);
  }

  const current = readAmmoState(weapon);
  const ammoItemId = itemId(ammoItem);
  if (current.reserveItemId != null && current.reserveItemId !== ammoItemId) {
    throw new Error('Selected ammo does not match the assigned reserve stack.');
  }

  const capacity = magazineCapacity(entry, level);
  const loaded = nonNegativeInt(current.loaded);

  // A reload is rejected (not silently clamped) when the magazine is over
  // full, for example after a tier change dropped the capacity, so the excess
  // is surfaced to the caller instead of being lost.
  if (loaded > capacity) {
    throw new Error(
      `The magazine holds ${loaded} rounds but its capacity is ${capacity} ` +
        `(${loaded - capacity} excess); empty the excess before reloading.`
    );
  }

  const option = reloadOptions(entry, level).find((o) => o.id === optionId);
  if (!option) {
    throw new Error(`Unknown reload option: ${optionId}.`);
  }

  const ammoId = ammoIdOf(ammoItem, entry);
  const loadedAmmoIdKnown =
    current.loadedAmmoId != null && String(current.loadedAmmoId).trim() !== '';

  // Never relabel loaded rounds with a new ammo id when their type is unknown:
  // reject the reload until the magazine is emptied manually or the loaded ammo
  // type is recovered, instead of silently assigning the incoming ammo id.
  if (loaded > 0 && !loadedAmmoIdKnown) {
    throw new Error(
      'The magazine holds loaded rounds of unknown ammunition; empty it manually or recover the ammo type before reloading.'
    );
  }

  if (loaded > 0 && loadedAmmoIdKnown) {
    if (!validAmmoIdForFamily(current.loadedAmmoId, ammoFamily(entry))) {
      throw new Error(
        'The magazine holds ammunition incompatible with this weapon; empty it before reloading.'
      );
    }
    if (current.loadedAmmoId !== ammoId) {
      throw new Error('Cannot mix different ammunition until the magazine is empty.');
    }
  }

  const qty = itemQuantity(ammoItem);
  if (!(qty > 0)) {
    throw new Error('The ammo stack is empty.');
  }

  // A non-magazine weapon (capacity 0) loads one round at a time.
  const space = capacity > 0 ? Math.max(0, capacity - loaded) : 1;
  const limit = option.mode === 'single' ? 1 : Infinity;
  const transferred = Math.min(space, qty, limit);
  if (transferred <= 0) {
    throw new Error('Nothing to reload (the magazine may already be full).');
  }

  const weaponState = {
    reserveItemId: current.reserveItemId ?? ammoItemId,
    loaded: capacity > 0 ? loaded + transferred : transferred,
    loadedAmmoId: ammoId,
  };

  return {
    weaponState,
    ammoQuantity: qty - transferred,
    transferred,
  };
}

// Plan a single shot. A magazine weapon (capacity > 0) validates that a round
// is loaded and decrements the loaded count without touching any ammo stack,
// so shots continue even after the reserve stack is deleted. A
// direct-consumption weapon (capacity 0) validates a compatible stack and
// decrements the stack's quantity, leaving the weapon state unchanged. A shot
// never spends both a loaded round and a stack round (no double spend).
export function planShot(weapon, ammoItem, entry, level = 'proficient') {
  const capacity = magazineCapacity(entry, level);
  const current = readAmmoState(weapon);

  if (capacity > 0) {
    const loaded = nonNegativeInt(current.loaded);
    if (!(loaded > 0)) {
      throw new Error('The magazine is empty.');
    }
    if (!current.loadedAmmoId) {
      throw new Error('No ammunition is loaded.');
    }
    if (!validAmmoIdForFamily(current.loadedAmmoId, ammoFamily(entry))) {
      throw new Error(
        'The magazine holds ammunition incompatible with this weapon.'
      );
    }
    const weaponState = {
      reserveItemId: current.reserveItemId,
      loaded: loaded - 1,
      loadedAmmoId: current.loadedAmmoId,
    };
    return { weaponState, ammoQuantity: null, ammoId: current.loadedAmmoId };
  }

  if (!compatibleAmmo(entry, ammoItem)) {
    throw new Error(`Ammunition is not compatible with ${entry?.name || 'this weapon'}.`);
  }
  const qty = itemQuantity(ammoItem);
  if (!(qty > 0)) {
    throw new Error('The ammo stack is empty.');
  }

  return {
    weaponState: current,
    ammoQuantity: qty - 1,
    ammoId: ammoIdOf(ammoItem, entry),
  };
}
