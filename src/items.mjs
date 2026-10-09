// Foundry-neutral catalog-to-dnd5e mapping and actor item sync.
//
// This module has no Foundry globals and no data dependencies beyond the RME
// training model. It produces dnd5e 4.x item `create` / `update` payloads that
// only ever touch module-owned fields, so user edits to damage bonuses,
// activities, enchantments, and any other data are left alone.
//
// Scope is deliberately conservative:
//   - Only unambiguous single `Melee NdX` / `Ranged NdX(+N)` damage tokens are
//     promoted into `system.damage.base`.
//   - Ranged range is set only when the selected tier is a sole ranged profile.
//   - A tier with no single unambiguous attack profile (zero damage tokens, or
//     two or more) is treated as a manual profile: any module-owned native
//     damage is zeroed (number 0, denomination 0, preserving user bonus/types)
//     and any prior native range value/long is cleared to null (units kept as
//     ft) so a stale / misleading profile is not left behind after training
//     moves away from a parseable tier. Such profiles are left for the user to
//     fill in manually.
//   - RME tactical properties (Hipshot, Keen, Puncture, ...) are written into
//     `system.properties` as namespaced `rme-*` keys (never into native dnd5e
//     keys), so they surface as weapon-property checkboxes without touching the
//     native property space. The active tier, its granted properties, and the
//     expert perk are recorded in the `foundry-rme` flag block.
//   - A conservative subset of shared RME weapon properties (Two-Handed, Finesse,
//     melee Reach, and unambiguous Versatile) is promoted into native dnd5e keys
//     (`two` / `fin` / `rch` / `ver`), and a genuinely Versatile weapon carries
//     its parsed two-handed die in `system.damage.versatile`. The module owns
//     only the keys it wrote: the promoted native keys are tracked in the
//     `foundry-rme.nativeProperties` flag and the written Versatile damage in
//     `nativeVersatileDamage` (with a snapshot of the exact value written), so
//     a user-added native key (or a user-set Versatile die) is never clobbered
//     and never removed on a later tier drop. The `nativeVersatileManual` flag
//     records whether the user has manually set/cleared the Versatile value: a
//     user-cleared zero die is preserved, while a native dnd5e default zero
//     (or a value the module itself cleared on a prior non-Versatile tier) is
//     left reclaimable so the module die can be written / restored later.

import { LEVELS, selectTier, resolveTraining } from './training.mjs';
import { parsePhysical, tierProperties, rmeWeaponType } from './rme-metadata.mjs';
import { magazineCapacity, reloadOptions } from './ammunition.mjs';
import { equipmentDescriptions } from './item-descriptions.mjs';
import { ICON_MAP } from './icon-map.mjs';
import { nativeProfile } from './native-properties.mjs';

export const FLAGS_KEY = 'foundry-rme';

// The stable module-owned activity ids for a magazine weapon's activities. Each
// is exactly 16 ASCII characters so it is safe as a Foundry embedded key.
export const RELOAD_FULL_ID = 'rmeReloadFull000';
export const RELOAD_FAST_ID = 'rmeReloadFast000';
// The default attack activity on a magazine weapon. dnd5e 6.x WeaponData
// ._preCreate skips generating a native attack when any reload Utility activity
// is present, so a magazine weapon must carry an explicit attack of its own.
export const ATTACK_ID = 'rmeAttack0000000';

// Explicit armor-name -> dnd5e armor category. The catalog derives armor names
// from the Armor.md table rows, so this is a fixed lookup rather than a guess.
export const ARMOR_TYPE_BY_NAME = {
  Padded: 'light',
  Leather: 'light',
  Studded: 'light',
  Lacquered: 'light',
  'Chain Shirt': 'medium',
  'Ring Mail': 'medium',
  Breastplate: 'medium',
  'Banded Mail': 'medium',
  Hauberk: 'heavy',
  'Scale Mail': 'heavy',
  Splint: 'heavy',
  Plate: 'heavy',
};

// ---------------------------------------------------------------------------
// HTML escaping / description
// ---------------------------------------------------------------------------

function escapeHtml(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// The full markdown source is kept verbatim (including line breaks) inside a
// <pre> block so it renders literally, while any HTML in the source is escaped
// so unknown markup can never inject a script into the sheet.
function descriptionValue(markdown) {
  return `<pre>${escapeHtml(markdown)}</pre>`;
}

// ---------------------------------------------------------------------------
// Tier selection
// ---------------------------------------------------------------------------

// Force the requested level as an explicit item override so `selectTier`
// returns the raw rows for that level no matter what any natural-weapon default
// would otherwise resolve to.
function tierForEntry(entry, level) {
  return selectTier(entry, { items: { [entry.id]: level } });
}

function proficientForLevel(level) {
  return level === 'proficient' || level === 'expert' ? 1 : 0;
}

// Map an input level to the levels understood by the training model. "basic" is
// accepted as an alias for "proficient" because the catalogs label the second
// tier "Basic" in some groups and "Proficient" in others; they are equivalent.
// Any other unknown level falls back to untrained.
function normalizeLevel(level) {
  if (level === 'basic') return 'proficient';
  return LEVELS.includes(level) ? level : 'untrained';
}

// ---------------------------------------------------------------------------
// Damage / range / mode parsing
// ---------------------------------------------------------------------------

function damageTokenRegex() {
  return /\b(Melee|Ranged)\s+(\d*d\d+(?:\+\d+)?)(?:\s+\((\d+)\/(\d+)\))?/g;
}

function collectDamageTokens(rawRows) {
  const tokens = [];
  for (const row of rawRows) {
    const re = damageTokenRegex();
    let m;
    while ((m = re.exec(row)) !== null) {
      tokens.push({
        mode: m[1],
        dice: m[2],
        normal: m[3] !== undefined ? Number(m[3]) : null,
        long: m[4] !== undefined ? Number(m[4]) : null,
        row,
      });
    }
  }
  return tokens;
}

// Normalize a catalog die expression ("d8", "2d4", "d8+3") into the atomic
// dnd5e base-damage parts. A bare `dX` is shorthand for `1dX`.
function parseDie(dice) {
  const m = /^(\d*)d(\d+)(?:\+(\d+))?$/.exec(dice);
  if (!m) return null;
  return {
    number: m[1] === '' ? 1 : Number(m[1]),
    denomination: Number(m[2]),
    bonus: m[3] !== undefined ? String(Number(m[3])) : '',
  };
}

function typesOf(value) {
  if (Array.isArray(value)) return value.slice();
  if (value && typeof value[Symbol.iterator] === 'function') return Array.from(value);
  return [];
}

function arraysEqual(a, b) {
  if (a.length !== b.length) return false;
  const set = new Set(b);
  return a.every((x) => set.has(x));
}

const DAMAGE_TYPE_SOURCE = String.raw`\b(Bludgeoning|Piercing|Slashing)\b`;

// Damage types come from the italic stat line at the top of source descriptions
// (e.g. "_Slashing, 4 lbs, 10 gp_"), never from prose. Returns lowercase dnd5e
// damage type keys, de-duplicated, in source order.
function damageTypesOf(entry) {
  const desc = String(entry.description || '');
  const stats = /^_([^_]+)_/m.exec(desc);
  if (!stats) return [];
  const re = new RegExp(DAMAGE_TYPE_SOURCE, 'gi');
  const seen = new Set();
  const types = [];
  let m;
  while ((m = re.exec(stats[1])) !== null) {
    const key = m[1].toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      types.push(key);
    }
  }
  return types;
}

// Build the dnd5e `system.damage.base` object. When a current item already
// carries a non-empty bonus or damage types (e.g. a user-added enchant),
// those are preserved and only the dice count/denomination come from the
// catalog. `current` is the item's `system` object, or null on creation.
function damageBaseFromToken(token, entry, current) {
  const parsed = parseDie(token.dice);
  if (!parsed) return null;
  const currentBase = current?.damage?.base || null;
  const bonus = currentBase?.bonus || parsed.bonus;
  const currentTypes = typesOf(currentBase?.types);
  const types = currentTypes.length > 0 ? currentTypes : damageTypesOf(entry);
  return { number: parsed.number, denomination: parsed.denomination, bonus, types };
}

// A sole ranged profile is exactly one Ranged damage token and no Melee token
// in the selected tier(s), with a parseable (normal/long) range.
function soleRangedProfile(tokens) {
  const ranged = tokens.filter((t) => t.mode === 'Ranged');
  const melee = tokens.filter((t) => t.mode === 'Melee');
  if (ranged.length !== 1 || melee.length !== 0) return false;
  const token = ranged[0];
  return token.normal !== null && token.long !== null;
}

function rangeFromToken(token) {
  return { value: token.normal, long: token.long, units: 'ft' };
}

// The "cleared" range shape used when a tier has no single unambiguous attack
// profile (or is a sole melee attack): prior native value/long are nulled while
// units are preserved as ft so the field no longer advertises a stale range.
function clearedRange() {
  return { value: null, long: null, units: 'ft' };
}

// Zero the module-owned native base damage when a tier has no single
// unambiguous attack profile. The user-added bonus and damage types (if any)
// are preserved; only the dice count/denomination are cleared.
function clearedDamageBase(current) {
  const base = current?.damage?.base || {};
  return {
    number: 0,
    denomination: 0,
    bonus: base.bonus || '',
    types: typesOf(base.types),
  };
}

// Determine the dnd5e weapon type from the selected raw row(s). Natural
// weapons are always `natural`. Otherwise the parsed damage tokens drive the
// decision; when the tokens are mixed or absent we fall back to a keyword scan
// of the raw rows, defaulting to melee.
function weaponModeOf(entry, rawRows, tokens) {
  if (entry.kind === 'natural') return 'natural';
  if (tokens.length > 0) {
    const modes = new Set(tokens.map((t) => t.mode));
    if (modes.size === 1) return modes.has('Ranged') ? 'simpleR' : 'simpleM';
  }
  let hasMelee = false;
  let hasRanged = false;
  for (const row of rawRows) {
    if (/\bMelee\b/.test(row)) hasMelee = true;
    if (/\bRanged\b/.test(row)) hasRanged = true;
  }
  if (hasRanged && !hasMelee) return 'simpleR';
  return 'simpleM';
}

// The dnd5e weapon type for an entry. RME catalog weapon groups resolve to a
// stable `rme<GroupName>` key (natural weapons stay the native `natural`), so a
// module-owned category is always written. Only when a group is not a known RME
// weapon group (e.g. a synthetic test entry) do we fall back to the legacy
// parse-driven melee/ranged classification.
function weaponTypeOf(entry, rawRows, tokens) {
  const rme = rmeWeaponType(entry.group);
  return rme?.key || weaponModeOf(entry, rawRows, tokens);
}

// ---------------------------------------------------------------------------
// Armor / shield values
// ---------------------------------------------------------------------------

// The armor description leads with the verbatim Armor.md table row:
// "<name> <AC> <stealth> <weight> <cost>".
function armorAC(entry) {
  const m = /^(.+?)\s+(\d+)\s+(None|Disadvantage|Normal)\s+(\d+)\s+(\d+)\s*$/m.exec(
    String(entry.description || '')
  );
  return m ? Number(m[2]) : 10;
}

// Shields carry a "+N AC" bonus in their italic stat line.
function shieldACBonus(entry) {
  const m = /\+\s*(\d+)\s*AC/.exec(String(entry.description || ''));
  return m ? Number(m[1]) : 0;
}

// ---------------------------------------------------------------------------
// RME tier metadata (properties / flags)
// ---------------------------------------------------------------------------

// The module-owned flag block written for a catalog entry at a resolved level.
// activeProperties mirrors `tierProperties` exactly (key/label/raw/parameter) so
// the sheet can surface the exact granted tier properties; expertPerk is the full
// source text or null when no perk applies.
function rmeFlags(entry, level, props) {
  return {
    catalogId: entry.id,
    group: entry.group,
    activeTier: level,
    activeProperties: props.map((p) => ({
      key: p.key,
      label: p.label,
      raw: p.raw,
      ...(p.parameter !== undefined ? { parameter: p.parameter } : {}),
    })),
    expertPerk: entry.expertPerk || null,
  };
}

// Merge the tier-granted RME properties and the native dnd5e weapon-property
// keys into an existing property array. `ownedNativeKeys` is the module-owned
// native key list previously recorded in the foundry-rme flag (from a prior
// sync); `native` is the native profile for the selected tier.
//
// Rules:
//   - `rme-*` keys are always replaced by the selected tier's granted keys (each
//     stale RME key not granted by the tier is dropped; a granted key that was
//     already present stays in place, and a granted key not already present is
//     appended).
//   - A native key previously recorded in `ownedNativeKeys` is module-owned: it
//     is removed and replaced by the selected tier's native keys, so a module
//     key no longer granted by the tier is dropped (never left as a stale
//     module value).
//   - A native key already present on the item but NOT recorded in
//     `ownedNativeKeys` is user-owned: it is preserved verbatim and never
//     claimed, so it survives even when a later tier no longer grants it.
//   - A native key newly added by the module (granted by the tier and not
//     already present) is claimed and recorded, so a later tier drop can remove
//     only keys the module actually owns.
//
// Returns `{ properties, nativeOwned }` where `nativeOwned` is the updated
// module-owned native key list to store in the foundry-rme flag.
function mergeNativeProperties(currentKeys, ownedNativeKeys, props, native) {
  const present = typesOf(currentKeys);
  const owned = new Set(typesOf(ownedNativeKeys));
  const granted = native.keys;
  const grantedRme = new Set(props.map((p) => p.key));

  // Preserve the item's existing ordering where possible: a still-granted rme-*
  // key stays in place, a stale rme-* key is dropped, a module-owned native key
  // is dropped (it is re-added canonically below if still granted), and every
  // other key (a user key, or an untracked user-set native key) is kept verbatim
  // in its original position. Newly granted keys are appended at the end.
  const properties = [];
  for (const key of present) {
    if (key.startsWith('rme-')) {
      if (grantedRme.has(key)) properties.push(key);
      continue;
    }
    if (owned.has(key)) continue;
    properties.push(key);
  }
  for (const prop of props) {
    if (!properties.includes(prop.key)) properties.push(prop.key);
  }
  for (const key of granted) {
    if (!properties.includes(key)) properties.push(key);
  }

  // Only keys the module actually owns are tracked. A key that was previously
  // owned and is still granted stays owned; a key newly added by this sync is
  // claimed; a key already present but never tracked (and not just re-added here)
  // is left to the user and never claimed.
  const newOwned = new Set();
  for (const key of typesOf(ownedNativeKeys)) {
    if (granted.includes(key)) newOwned.add(key);
  }
  for (const key of granted) {
    if (newOwned.has(key)) continue;
    if (present.includes(key) && !owned.has(key)) continue;
    newOwned.add(key);
  }

  return { properties, nativeOwned: sortedKeys(newOwned) };
}

// Sort and de-duplicate a native key list so the module-owned flag is always
// written in a stable order (idempotent flag comparison).
function sortedKeys(keys) {
  return [...new Set(typesOf(keys))].sort();
}

// ---------------------------------------------------------------------------
// Versatile damage
// ---------------------------------------------------------------------------

// Whether a Versatile damage value is absent or a native dnd5e zero/default
// object (number 0 / denomination 0) that the module may safely reclaim with
// its parsed die. A user-cleared die (number 0 / denomination 0) that must be
// preserved is distinguished by the `nativeVersatileManual` marker: this
// helper is only ever consulted when that marker is false, so a user-cleared
// zero never reaches here. Only a fully missing (undefined / null) value or a
// number 0 / denomination 0 die is treated as a reclaimable module default.
function versatileEmptyOrDefault(value) {
  return !value || (value.number === 0 && value.denomination === 0);
}

// Build the module-owned Versatile damage object. The dice come from the parsed
// native Versatile die; the bonus and damage types mirror the base damage, so a
// user enchant/bonus or damage type on the one-handed mode is never silently
// dropped from the two-handed mode. Never copies the base dice (the base and
// Versatile dice differ).
function versatileDamageValue(entry, native, base) {
  const bonus = base?.bonus ?? '';
  const types = typesOf(base?.types);
  return {
    number: native.versatile.number,
    denomination: native.versatile.denomination,
    bonus,
    types: types.length > 0 ? types : damageTypesOf(entry),
  };
}

// The "cleared" Versatile damage used when a tier no longer grants Versatile:
// zero dice and a blank bonus, while any damage types are preserved so a user
// type selection is not lost. Only ever written over a module-owned value.
function clearedVersatileDamage(current) {
  return {
    number: 0,
    denomination: 0,
    bonus: '',
    types: typesOf(current?.types),
  };
}

// The normalized snapshot of a written native Versatile damage value, used to
// detect a later user edit by comparing the live value to what the module last
// wrote. Only the module-owned fields are recorded; any dnd5e schema defaults a
// live value carries are ignored, and types are normalized to an array.
function snapshotOfVersatile(value) {
  if (!value) return null;
  return {
    number: value.number,
    denomination: value.denomination,
    bonus: value.bonus,
    types: typesOf(value.types),
  };
}

// Whether two native Versatile snapshots are equal as module-owned records. An
// absent snapshot and an explicit null are equivalent (both mean "no snapshot"),
// so a sync compares idempotently even when the field was never written.
function snapshotEqual(a, b) {
  const na = a && typeof a === 'object' ? a : null;
  const nb = b && typeof b === 'object' ? b : null;
  if (!na && !nb) return true;
  if (!na || !nb) return false;
  return versatileEqual(na, nb);
}

// Repairs a legacy zero / null / missing weight or price from the parsed source,
// but never overwrites a nonzero user-edited value. Returns a partial `{weight}` /
// `{price}` object (empty when nothing needs repairing).
function repairPhysical(current, parsed) {
  const out = {};
  const weight = parsed.weight;
  const price = parsed.price;
  if (weight && weight.value > 0 && (current?.weight?.value == null || current.weight.value === 0)) {
    out.weight = weight;
  }
  if (price && price.value > 0 && (current?.price?.value == null || current.price.value === 0)) {
    out.price = price;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Reload activities
// ---------------------------------------------------------------------------

// The default dnd5e weapon attack activity, included so a magazine weapon can
// carry its reload activities without dnd5e auto-creating a duplicate native
// attack (and so the attack is always ordered first). Only module-owned fields
// that dnd5e's activity schema does not already default are written; the rest of
// the activity data is filled in by the system when the item loads.
function defaultAttackActivity() {
  return {
    _id: ATTACK_ID,
    sort: 0,
    type: 'attack',
    name: 'Attack',
  };
}

// Build one utility reload activity from a reload option. The source shape is
// fixed and module-owned; dnd5e fills any schema defaults (description, img,
// duration, range, target, uses, and so on) when the item is loaded. Only the
// module-owned fields are written so user/schema defaults are not clobbered.
function reloadActivityFromOption(option, id, sort) {
  return {
    _id: id,
    sort,
    type: 'utility',
    name: `RME ${option.label}`,
    activation: {
      type: option.activationType,
      value: 1,
      condition: option.label,
      override: false,
    },
    consumption: {
      targets: [],
      scaling: { allowed: false, max: '' },
      spellSlot: false,
    },
    roll: { formula: '', name: '', prompt: false, visible: false },
    flags: { [FLAGS_KEY]: { reloadOptionId: option.id } },
  };
}

// The module-owned reload activities for an entry at a level, keyed by the
// stable ids. A non-magazine weapon (capacity 0) returns an empty object. The
// plain full-action ("action-full") reload is always present and maps to
// `rmeReloadFull000`; a faster tier-specific second option (when `reloadOptions`
// carries one) maps to `rmeReloadFast000`. Both are written only when the
// magazine capacity is positive.
export function reloadActivityData(entry, level = 'untrained') {
  const safeLevel = normalizeLevel(level);
  if (magazineCapacity(entry, safeLevel) <= 0) return {};
  const options = reloadOptions(entry, safeLevel);
  if (options.length === 0) return {};

  const out = {};
  const full = options.find((o) => o.id === 'action-full');
  if (full) {
    out[RELOAD_FULL_ID] = reloadActivityFromOption(full, RELOAD_FULL_ID, 1);
  }
  if (options.length > 1) {
    const fast = options[1];
    if (fast && fast.id !== 'action-full') {
      out[RELOAD_FAST_ID] = reloadActivityFromOption(fast, RELOAD_FAST_ID, 2);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// makeItemData
// ---------------------------------------------------------------------------

// Build a complete dnd5e item `create` payload for a catalog entry at a given
// training level. Returns an object suitable for `Item.create`.
//
// The payload is module-owned throughout: it sets the RME weapon category, the
// tier-granted `rme-*` weapon properties, the promoted native dnd5e weapon
// property keys (two / fin / rch / ver) and, for a genuinely Versatile weapon,
// the parsed two-handed `system.damage.versatile`, the parsed physical stats
// (weight / price, never fabricated for natural weapons which have none),
// proficient state, and the module flag block (catalogId, group, activeTier, the
// resolved activeProperties, expertPerk, and the module-owned native property
// list / Versatile damage ownership flag).
export function makeItemData(entry, level = 'untrained') {
  const safeLevel = normalizeLevel(level);
  const kind = entry.kind;
  const tier = tierForEntry(entry, safeLevel);
  const tokens = collectDamageTokens(tier.rawRows);
  const props = tierProperties(entry, safeLevel);
  const native = nativeProfile(entry, safeLevel);
  const physical = parsePhysical(entry);
  const descriptions = equipmentDescriptions(entry);

  const payload = {
    name: entry.name,
    type: kind === 'weapon' || kind === 'natural' ? 'weapon' : 'equipment',
    img: ICON_MAP[entry.id],
    flags: {
      [FLAGS_KEY]: {
        ...rmeFlags(entry, safeLevel, props),
        nativeProperties: sortedKeys(native.keys),
        nativeVersatileDamage: false,
        nativeVersatileSnapshot: null,
        nativeVersatileManual: false,
      },
    },
    system: {
      description: {
        value: descriptions.identifiedHtml,
        chat: descriptions.chatHtml,
      },
      unidentified: {
        name: descriptions.unidentifiedName,
        description: descriptions.unidentifiedHtml,
      },
    },
  };

  if (kind === 'weapon' || kind === 'natural') {
    payload.system.type = { value: weaponTypeOf(entry, tier.rawRows, tokens) };
    payload.system.proficient = proficientForLevel(safeLevel);
    payload.system.properties = [...props.map((p) => p.key), ...native.keys];

    const base = tokens.length === 1 ? damageBaseFromToken(tokens[0], entry) : null;
    const reload = reloadActivityData(entry, safeLevel);
    const hasReload = Object.keys(reload).length > 0;
    if (base) {
      payload.system.damage = { base };
    }
    if (native.keys.includes('ver') && native.versatile) {
      // A genuinely Versatile weapon carries a native `ver` property and its
      // parsed two-handed die. The versatile damage never assumes the base dice;
      // it takes the parsed die and mirrors the base bonus/types. The written
      // value is snapshotted so a later user edit to any field can be detected.
      payload.system.damage = payload.system.damage || {};
      const versatileOverride = versatileDamageValue(entry, native, base);
      payload.system.damage.versatile = versatileOverride;
      payload.flags[FLAGS_KEY].nativeVersatileDamage = true;
      payload.flags[FLAGS_KEY].nativeVersatileSnapshot = snapshotOfVersatile(versatileOverride);
    }
    if (hasReload) {
      // A magazine weapon carries its reload activities and an explicit native
      // attack. dnd5e 6.x does not auto-create an attack when a reload Utility
      // activity is present, so the attack must be supplied (and ordered first).
      payload.system.activities = {
        [ATTACK_ID]: defaultAttackActivity(),
        ...reload,
      };
    } else if (!base) {
      // No parseable damage and no reload: suppress the native attack activity
      // that the dnd5e system would otherwise auto-create for a weapon.
      payload.system.activities = {};
    }
    if (soleRangedProfile(tokens)) {
      payload.system.range = rangeFromToken(tokens[0]);
    }
  } else if (kind === 'armor') {
    payload.system.type = { value: ARMOR_TYPE_BY_NAME[entry.name] || 'light' };
    payload.system.proficient = proficientForLevel(safeLevel);
    payload.system.armor = { value: armorAC(entry) };
  } else if (kind === 'shield') {
    payload.system.type = { value: 'shield' };
    payload.system.proficient = proficientForLevel(safeLevel);
    payload.system.armor = { value: shieldACBonus(entry) };
  } else {
    // Unknown kind: a generic piece of equipment, no armor stats.
    payload.system.proficient = proficientForLevel(safeLevel);
  }

  // Physical stats come only from the parsed source (natural weapons parse to
  // nothing, so no weight/price is fabricated for them).
  if (physical.weight) payload.system.weight = physical.weight;
  if (physical.price) payload.system.price = physical.price;

  return payload;
}

// ---------------------------------------------------------------------------
// Description / unidentified / icon migration
// ---------------------------------------------------------------------------

// The legacy escaped `<pre>` of the verbatim source description that the
// original mapper wrote into `system.description.value`. Used to detect an
// item that still carries the old, un-curated description so it can be migrated
// rather than preserved as user prose.
function legacyDescriptionValue(entry) {
  return descriptionValue(entry.description);
}

function blankOrMissing(value) {
  return value === undefined || value === null || value === '';
}

// A legacy item's description.value is migrated only when it is blank (never
// populated) or still exactly equals the legacy escaped `<pre>` wrapper of the
// verbatim source description. Any other text is treated as user-authored prose
// and preserved.
function descriptionNeedsMigration(current, entry) {
  const value = current?.description?.value;
  return blankOrMissing(value) || value === legacyDescriptionValue(entry);
}

// The common Foundry default placeholder icons a legacy / un-populated item may
// carry. Any other (user-curated) icon is preserved. An absent icon is treated
// as needing the curated icon.
const DEFAULT_ICON_PATHS = new Set([
  'icons/svg/item-bag.svg',
  'icons/svg/sword.svg',
  'icons/svg/shield.svg',
  'icons/svg/armor.svg',
  'icons/svg/mystery-man.svg',
]);

function iconNeedsMigration(currentImg) {
  return blankOrMissing(currentImg) || DEFAULT_ICON_PATHS.has(currentImg);
}

// The partial `system.description` update. `value` is replaced only when it is
// blank or still the legacy `<pre>`; `chat` is filled only when blank/missing.
// Returns an empty object when nothing needs to change, so no description field
// is ever touched on an already-curated item.
function descriptionPatch(current, entry, descriptions) {
  const desc = current?.description || {};
  const out = {};
  if (descriptionNeedsMigration(current, entry)) {
    out.value = descriptions.identifiedHtml;
  }
  if (blankOrMissing(desc.chat)) {
    out.chat = descriptions.chatHtml;
  }
  return out;
}

// The partial `system.unidentified` update. Name/description are filled only
// when blank/missing, so a user-set unidentified label is never overwritten.
function unidentifiedPatch(current, descriptions) {
  const unid = current?.unidentified || {};
  const out = {};
  if (blankOrMissing(unid.name)) {
    out.name = descriptions.unidentifiedName;
  }
  if (blankOrMissing(unid.description)) {
    out.description = descriptions.unidentifiedHtml;
  }
  return out;
}

// ---------------------------------------------------------------------------
// itemProfilePatch
// ---------------------------------------------------------------------------

// Build a differential update for an existing embedded item. Only module-owned
// fields are returned: `system.type`, `system.proficient`, `system.properties`
// (the tier `rme-*` keys plus the promoted native keys, merged over the existing
// native/user properties without clobbering user-owned native keys or Versatile
// damage), the parsed physical stats repaired only when currently zero/null/
// missing, the module-owned reload activities for a magazine weapon (as dotted
// `system.activities.<id>` keys, plus the `.-=` deletion operator to drop a
// stale fast reload), the module-owned default attack for a magazine weapon that
// has no attack yet (a magazine weapon cannot rely on dnd5e auto-creating one),
// and the module flag block (activeTier / activeProperties / expertPerk /
// nativeProperties / nativeVersatileDamage). Damage and range follow the legacy
// conservative rules: a single unambiguous damage token is promoted into
// `system.damage.base`, a sole ranged profile sets `system.range`, and a tier
// with no single unambiguous attack profile zeroes/clears prior module-owned
// native damage/range so a stale parseable profile is not left behind. Name,
// description, enchantments, and any non-module activity id are never included.
export function itemProfilePatch(item, entry, level = 'untrained') {
  const safeLevel = normalizeLevel(level);
  const system = { proficient: proficientForLevel(safeLevel) };
  const props = tierProperties(entry, safeLevel);
  const native = nativeProfile(entry, safeLevel);
  const current = item.system || {};
  const descriptions = equipmentDescriptions(entry);
  const physical = repairPhysical(current, parsePhysical(entry));
  if (physical.weight) system.weight = physical.weight;
  if (physical.price) system.price = physical.price;

  // The module-owned native property / Versatile ownership state, populated in
  // the weapon branch (or left as the safe default for a non-weapon entry).
  let nativeOwnedKeys = sortedKeys(native.keys);
  let nativeVersatileDamage = false;
  let nativeVersatileSnapshot = null;
  let nativeVersatileManual = false;

  if (entry.kind === 'weapon' || entry.kind === 'natural') {
    const tier = tierForEntry(entry, safeLevel);
    const tokens = collectDamageTokens(tier.rawRows);
    system.type = { value: weaponTypeOf(entry, tier.rawRows, tokens) };
    const merged = mergeNativeProperties(
      current.properties,
      item.flags?.[FLAGS_KEY]?.nativeProperties,
      props,
      native
    );
    system.properties = merged.properties;
    nativeOwnedKeys = merged.nativeOwned;
    if (tokens.length === 1) {
      system.damage = { base: damageBaseFromToken(tokens[0], entry, item.system) };
      if (soleRangedProfile(tokens)) {
        system.range = rangeFromToken(tokens[0]);
      } else if (item.system?.range) {
        // A sole melee attack (or a ranged token without a parseable range):
        // clear any stale native range a prior ranged tier left behind. Only
        // patched when the module-owned range field is present, so a brand-new
        // blank actor item does not get a spurious null-range write.
        system.range = clearedRange();
      }
    } else if (item.system?.damage?.base) {
      // No single unambiguous attack profile: zero the module-owned native
      // damage (preserving user-added bonus/types) and clear any prior native
      // range so misleading values do not persist after training moves off a
      // parseable tier. Each field is only patched when it is already present
      // (module-owned), avoiding spurious writes on brand-new blank items.
      system.damage = { base: clearedDamageBase(item.system) };
      if (item.system?.range) {
        system.range = clearedRange();
      }
    }

    // Native Versatile damage. The module owns `system.damage.versatile` only
    // when it wrote it (nativeVersatileDamage flag) and has a snapshot of the
    // exact value it wrote; a user-set value that was never module-owned is
    // preserved untouched. For a previously module-owned value the
    // snapshot/live match is evaluated FIRST, so a user-cleared die (current
    // number 0) is never mistaken for the safe default and rewritten; a
    // mismatch or a missing snapshot preserves the current value and
    // relinquishes ownership. The `nativeVersatileManual` marker tracks whether
    // the user has manually set/cleared the value: when set, the current value
    // (including a zero die) is always preserved; when clear, the module may
    // write its parsed two-handed die into an absent or native zero/default
    // value (including one the module itself cleared on a prior non-Versatile
    // tier), so a module-cleared value is restored when a later tier grants
    // Versatile again. Only a value that was NOT previously module-owned and is
    // genuinely absent or a zero/default object (and not manual) may initiate a
    // new module write of the parsed two-handed die (with the base bonus/
    // types). When the tier drops Versatile, only a previously module-owned
    // value whose live value still matches its snapshot is cleared (zero dice/
    // blank bonus), never user data.
    const currentVersatile = item.system?.damage?.versatile;
    const currentFlag = item.flags?.[FLAGS_KEY] ?? {};
    nativeVersatileManual = currentFlag.nativeVersatileManual === true;
    const moduleOwnedVersatile = currentFlag.nativeVersatileDamage === true;
    const snapshot = currentFlag.nativeVersatileSnapshot;
    if (native.keys.includes('ver') && native.versatile) {
      if (moduleOwnedVersatile) {
        // Previously module-owned: evaluate the snapshot/live match FIRST, so a
        // user-cleared die (current number 0) is never mistaken for the safe
        // default/cleared shape and rewritten. A mismatch (or a legacy flag with
        // no snapshot) means the user edited a field, so the current value is
        // preserved untouched and ownership is relinquished; the manual marker
        // is set so the user's value is never reclaimed by a later tier.
        if (snapshot && typeof snapshot === 'object' && versatileEqual(currentVersatile, snapshot)) {
          // Unchanged module-owned value: continue owning it and write the
          // current tier's die (an upgrade/downgrade), then re-snapshot. The
          // manual marker stays false: the value is module-written.
          system.damage = system.damage || {};
          const value = versatileDamageValue(entry, native, system.damage?.base);
          system.damage.versatile = value;
          nativeVersatileDamage = true;
          nativeVersatileSnapshot = snapshotOfVersatile(value);
          nativeVersatileManual = false;
        } else {
          // A user edit (including clearing the die to zero), or a legacy flag
          // with no snapshot: leave the value alone and stop owning it.
          nativeVersatileDamage = false;
          nativeVersatileSnapshot = null;
          nativeVersatileManual = true;
        }
      } else if (!nativeVersatileManual && versatileEmptyOrDefault(currentVersatile)) {
        // Not previously module-owned, no manual marker, and the value is
        // genuinely absent or a native zero/default object (a default dnd5e
        // value, or a value the module itself cleared on a prior non-Versatile
        // tier): write the parsed two-handed die and claim ownership.
        system.damage = system.damage || {};
        const value = versatileDamageValue(entry, native, system.damage?.base);
        system.damage.versatile = value;
        nativeVersatileDamage = true;
        nativeVersatileSnapshot = snapshotOfVersatile(value);
        nativeVersatileManual = false;
      } else if (!nativeVersatileManual) {
        // Not previously module-owned and not a zero/default object: a user-
        // supplied nonempty value is preserved and the manual marker is set so
        // it is never reclaimed by a later tier.
        nativeVersatileDamage = false;
        nativeVersatileSnapshot = null;
        nativeVersatileManual = true;
      } else {
        // Manual marker set (a user-supplied or user-cleared value): preserve
        // whatever is there (including a zero die) and do not claim ownership.
        nativeVersatileDamage = false;
        nativeVersatileSnapshot = null;
        nativeVersatileManual = true;
      }
    } else if (moduleOwnedVersatile) {
      // The tier no longer grants Versatile. Clear only when the live value
      // still matches the snapshot (module-owned); a user edit is preserved
      // untouched and ownership relinquished (with the manual marker set).
      if (snapshot && typeof snapshot === 'object' && versatileEqual(currentVersatile, snapshot)) {
        system.damage = system.damage || {};
        system.damage.versatile = clearedVersatileDamage(currentVersatile);
        nativeVersatileDamage = false;
        nativeVersatileSnapshot = null;
        nativeVersatileManual = false;
      } else {
        nativeVersatileDamage = false;
        nativeVersatileSnapshot = null;
        nativeVersatileManual = true;
      }
    }

    // Module-owned reload activities for a magazine weapon, written as dotted
    // `system.activities.<id>` keys so user-defined activity ids are left alone.
    // A module-owned reload activity no longer granted by the tier (e.g. the
    // fast reload once a source tier drops it) is removed via the `.-=` deletion
    // operator, which also never touches any other activity id.
    const reload = reloadActivityData(entry, safeLevel);
    const currentActivities = item.system?.activities || {};
    for (const [id, activity] of Object.entries(reload)) {
      system[`activities.${id}`] = activity;
    }
    for (const id of [RELOAD_FULL_ID, RELOAD_FAST_ID]) {
      if (!reload[id] && activityById(currentActivities, id)) {
        system[`activities.-=${id}`] = null;
      }
    }
    // A magazine weapon must carry an explicit native attack, since dnd5e does
    // not auto-create one when a reload Utility activity is present. Add the
    // module-owned default (as a granular dotted path) only when no attack
    // activity (native or user-added) exists; never add a second attack or
    // replace an existing one.
    if (Object.keys(reload).length > 0) {
      const hasAttack = activityValues(currentActivities).some((a) => a?.type === 'attack');
      if (!hasAttack) {
        system[`activities.${ATTACK_ID}`] = defaultAttackActivity();
      }
    }
  } else if (entry.kind === 'armor') {
    system.type = { value: ARMOR_TYPE_BY_NAME[entry.name] || 'light' };
  } else if (entry.kind === 'shield') {
    system.type = { value: 'shield' };
  }

  // Curated description / unidentified / icon migration. Each is written only
  // when the current value is still module-owned (blank, legacy `<pre>`, or the
  // common Foundry placeholder icon), so user-authored prose, chat, and icon are
  // never overwritten. A fully-curated item writes none of these keys, keeping
  // the patch and the sync strictly module-owned and idempotent.
  const descPatch = descriptionPatch(current, entry, descriptions);
  if (Object.keys(descPatch).length > 0) {
    system.description = { ...(current.description || {}), ...descPatch };
  }
  const unidPatch = unidentifiedPatch(current, descriptions);
  if (Object.keys(unidPatch).length > 0) {
    system.unidentified = { ...(current.unidentified || {}), ...unidPatch };
  }
  let img;
  if (iconNeedsMigration(item.img)) {
    img = ICON_MAP[entry.id];
  }

  const flags = {
    [FLAGS_KEY]: {
      ...(item.flags?.[FLAGS_KEY] || {}),
      ...rmeFlags(entry, safeLevel, props),
      nativeProperties: nativeOwnedKeys,
      nativeVersatileDamage,
      nativeVersatileSnapshot,
      nativeVersatileManual,
    },
  };

  const patch = { _id: item._id, system, flags };
  if (img !== undefined) patch.img = img;
  return patch;
}

// ---------------------------------------------------------------------------
// syncActorItems
// ---------------------------------------------------------------------------

function damageBaseEqual(a, b) {
  if (!a || !b) return false;
  return (
    a.number === b.number &&
    a.denomination === b.denomination &&
    a.bonus === b.bonus &&
    arraysEqual(typesOf(a.types), typesOf(b.types))
  );
}

function versatileEqual(a, b) {
  if (!a || !b) return false;
  return (
    a.number === b.number &&
    a.denomination === b.denomination &&
    a.bonus === b.bonus &&
    arraysEqual(typesOf(a.types), typesOf(b.types))
  );
}

function rangeEqual(a, b) {
  if (!a || !b) return false;
  return a.value === b.value && a.long === b.long && a.units === b.units;
}

function typeEqual(a, b) {
  return String(a?.value ?? '') === String(b?.value ?? '');
}

// Weapon properties are treated as a set: order is not semantically meaningful
// to the dnd5e system, so a reorder alone is not a difference.
function propertiesEqual(a, b) {
  const setA = new Set(typesOf(a));
  const setB = new Set(typesOf(b));
  if (setA.size !== setB.size) return false;
  for (const key of setA) {
    if (!setB.has(key)) return false;
  }
  return true;
}

function weightEqual(a, b) {
  if (!a || !b) return false;
  return a.value === b.value && a.units === b.units;
}

function priceEqual(a, b) {
  if (!a || !b) return false;
  return a.value === b.value && a.denomination === b.denomination;
}

function deepEqual(a, b) {
  if (a === b) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) {
    return false;
  }
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) {
    if (a.length !== b.length) return false;
    return a.every((x, i) => deepEqual(x, b[i]));
  }
  const keysA = Object.keys(a);
  const keysB = Object.keys(b);
  if (keysA.length !== keysB.length) return false;
  return keysA.every((k) => deepEqual(a[k], b[k]));
}

// Compare only the module-owned flag fields (activeTier / activeProperties /
// expertPerk), never any user-added key under the foundry-rme flag namespace.
// A tagged catalog item that carries a foundry-rme flag block but none of the
// module metadata yet (only catalogId/group, e.g. a legacy item from an old
// release) is treated as differing, so a single sync write populates the
// metadata even when every native system field already matches the tier.
// Unrelated/user-added keys under the namespace are preserved by the patch, and
// once the metadata has been written the item compares equal, keeping the
// operation idempotent after that first update.
function rmeFlagEqual(item, target) {
  const current = item.flags?.[FLAGS_KEY] || {};
  const targetFlags = target[FLAGS_KEY] || {};
  const hasCurrent =
    current.activeTier !== undefined ||
    current.activeProperties !== undefined ||
    current.expertPerk !== undefined ||
    current.nativeProperties !== undefined ||
    current.nativeVersatileDamage !== undefined ||
    current.nativeVersatileSnapshot !== undefined ||
    current.nativeVersatileManual !== undefined;
  if (!hasCurrent) return false;
  return (
    current.activeTier === targetFlags.activeTier &&
    deepEqual(current.activeProperties || [], targetFlags.activeProperties || []) &&
    current.expertPerk === targetFlags.expertPerk &&
    deepEqual(sortedKeys(current.nativeProperties), targetFlags.nativeProperties) &&
    (current.nativeVersatileDamage === true) === (targetFlags.nativeVersatileDamage === true) &&
    (current.nativeVersatileManual === true) === (targetFlags.nativeVersatileManual === true) &&
    snapshotEqual(current.nativeVersatileSnapshot, targetFlags.nativeVersatileSnapshot)
  );
}

// Read one activity out of an activities collection whether it is a live dnd5e
// 6.x MappingField/Collection (a Map-like keyed by id) or a plain serialized
// object keyed by id. A live Collection exposes `.get(id)`; a serialized object
// is addressed by its own key. Never falls back to a non-own key, so a live
// Map is never misread as a plain object.
function activityById(activities, id) {
  if (!activities) return undefined;
  if (typeof activities.get === 'function') return activities.get(id);
  return activities[id];
}

// Enumerate the activities in a collection whether it is live (a Map-like
// Collection exposing `.values()`) or a plain serialized object. A live
// Collection must be read via its iterator, since `Object.values` on a Map would
// enumerate its internal slots rather than the activities.
function activityValues(activities) {
  if (!activities) return [];
  if (typeof activities.values === 'function') return Array.from(activities.values());
  return Object.values(activities);
}

// Compare one module-owned reload activity against its target by the normalized
// shape the module controls (name, type, activation type/condition, and the
// reload-option flag). Only these fields are compared, reading them field by
// field rather than deep-comparing the whole object, so dnd5e's schema defaults
// on a stored live DataModel never register as a difference (and therefore a
// spurious sync loop). A target of `null` means the tier does not grant that
// activity; the current item must then not carry it either.
function reloadActivityMatches(current, target) {
  if (!target) return !current;
  if (!current) return false;
  return (
    current.name === target.name &&
    current.type === target.type &&
    current.activation?.type === target.activation?.type &&
    current.activation?.condition === target.activation?.condition &&
    current.flags?.[FLAGS_KEY]?.reloadOptionId === target.flags?.[FLAGS_KEY]?.reloadOptionId
  );
}

// Compare only the module-managed reload activities (full/fast) between an item
// and the target set, ignoring any user-defined activity id (and the module's
// own default attack activity). Returns true only when both module-managed
// reload activities match their target in normalized shape.
function reloadActivitiesEqual(item, target) {
  const current = item.system?.activities || {};
  if (!reloadActivityMatches(activityById(current, RELOAD_FULL_ID), target[RELOAD_FULL_ID])) return false;
  if (!reloadActivityMatches(activityById(current, RELOAD_FAST_ID), target[RELOAD_FAST_ID])) return false;
  return true;
}

// Whether a magazine weapon lacks an explicit native attack activity. dnd5e 6.x
// does not auto-create an attack when a reload Utility activity is present, so a
// magazine weapon must carry one explicitly. The guard fires only for a magazine
// weapon (a non-empty target reload set) and only when no attack activity
// (module-owned or user-added) is present, so an existing user attack is never
// replaced and the module default is never stacked on top of it.
function attackActivityMissing(item, targetReload) {
  if (Object.keys(targetReload).length === 0) return false;
  const current = item.system?.activities || {};
  return !activityValues(current).some((a) => a?.type === 'attack');
}

// Sync embedded items on `actor` that carry `flags['foundry-rme'].catalogId`
// and are present in `equipment` (an iterable of catalog entries). Items that
// are unknown (no catalogId, or an id not in the catalog) are left untouched.
// Writes are batched through `actor.updateEmbeddedDocuments('Item', updates)`
// and only issued when a module-owned field actually differs, keeping the
// operation idempotent and preserving any user-added data that it does not own.
// Returns the array of updates that were applied.
export async function syncActorItems(actor, equipment, training = {}) {
  const byId = new Map();
  for (const entry of equipment) byId.set(entry.id, entry);

  const updates = [];
  for (const item of actor.items) {
    const catalogId = item.flags?.[FLAGS_KEY]?.catalogId;
    if (!catalogId) continue;
    const entry = byId.get(catalogId);
    if (!entry) continue;

    const level = resolveTraining(entry, training);
    const patch = itemProfilePatch(item, entry, level);
    const system = patch.system;
    const targetReload = reloadActivityData(entry, level);

    const differs =
      (system.proficient !== undefined &&
        item.system?.proficient !== system.proficient) ||
      (system.type && !typeEqual(item.system?.type, system.type)) ||
      (system.properties && !propertiesEqual(item.system?.properties, system.properties)) ||
      (system.damage?.base &&
        !damageBaseEqual(item.system?.damage?.base, system.damage.base)) ||
      (system.damage?.versatile &&
        !versatileEqual(item.system?.damage?.versatile, system.damage.versatile)) ||
      (system.range && !rangeEqual(item.system?.range, system.range)) ||
      (system.weight && !weightEqual(item.system?.weight, system.weight)) ||
      (system.price && !priceEqual(item.system?.price, system.price)) ||
      !reloadActivitiesEqual(item, targetReload) ||
      attackActivityMissing(item, targetReload) ||
      (patch.flags && !rmeFlagEqual(item, patch.flags)) ||
      // Curated description / unidentified / icon migration. Each of these is
      // only ever present on the patch when the current value is still
      // module-owned (blank / legacy `<pre>` / placeholder icon), so their
      // presence alone is the difference; after the first write the patch omits
      // them and the item compares equal.
      patch.img !== undefined ||
      patch.system.description !== undefined ||
      patch.system.unidentified !== undefined;

    if (differs) updates.push(patch);
  }

  if (updates.length > 0) {
    await actor.updateEmbeddedDocuments('Item', updates);
  }
  return updates;
}
