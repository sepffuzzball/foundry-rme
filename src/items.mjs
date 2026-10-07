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
//   - RME tactical properties (Hipshot, Keen, Puncture, ...) are not mapped
//     into dnd5e native properties (`system.properties` is left untouched).

import { LEVELS, selectTier, resolveTraining } from './training.mjs';

export const FLAGS_KEY = 'foundry-rme';

// Explicit armor-name -> dnd5e armor category. The catalog derives armor names
// from the Armor.md table rows, so this is a fixed lookup rather than a guess.
const ARMOR_TYPE_BY_NAME = {
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
// makeItemData
// ---------------------------------------------------------------------------

// Build a complete dnd5e item `create` payload for a catalog entry at a given
// training level. Returns an object suitable for `Item.create`.
export function makeItemData(entry, level = 'untrained') {
  const safeLevel = LEVELS.includes(level) ? level : 'untrained';
  const kind = entry.kind;
  const tier = tierForEntry(entry, safeLevel);
  const tokens = collectDamageTokens(tier.rawRows);

  const payload = {
    name: entry.name,
    type: kind === 'weapon' || kind === 'natural' ? 'weapon' : 'equipment',
    flags: { [FLAGS_KEY]: { catalogId: entry.id, group: entry.group } },
    system: { description: { value: descriptionValue(entry.description) } },
  };

  if (kind === 'weapon' || kind === 'natural') {
    payload.system.type = { value: weaponModeOf(entry, tier.rawRows, tokens) };
    payload.system.proficient = proficientForLevel(safeLevel);

    const base = tokens.length === 1 ? damageBaseFromToken(tokens[0], entry) : null;
    if (base) {
      payload.system.damage = { base };
    } else {
      // No parseable damage: suppress any native attack activity that the
      // dnd5e system would otherwise auto-create for a weapon.
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

  return payload;
}

// ---------------------------------------------------------------------------
// itemProfilePatch
// ---------------------------------------------------------------------------

// Build a differential update for an existing embedded item. Only module-owned
// fields are returned: `system.proficient` always, plus `system.damage.base`
// and `system.range` for a weapon when the selected tier yields a single
// unambiguous damage token. When a weapon/natural tier yields no single
// unambiguous attack profile (zero or multiple tokens), any prior module-owned
// native damage/range is cleared (zeroed / nulled, user bonus/types preserved)
// so a stale parseable profile is not left behind; such tiers are manual.
// Name, description, flags, activities, enchantments, and any other field are
// never included.
export function itemProfilePatch(item, entry, level = 'untrained') {
  const safeLevel = LEVELS.includes(level) ? level : 'untrained';
  const system = { proficient: proficientForLevel(safeLevel) };

  if (entry.kind === 'weapon' || entry.kind === 'natural') {
    const tier = tierForEntry(entry, safeLevel);
    const tokens = collectDamageTokens(tier.rawRows);
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
  }

  return { _id: item._id, system };
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

function rangeEqual(a, b) {
  if (!a || !b) return false;
  return a.value === b.value && a.long === b.long && a.units === b.units;
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

    const differs =
      (system.proficient !== undefined &&
        item.system?.proficient !== system.proficient) ||
      (system.damage?.base &&
        !damageBaseEqual(item.system?.damage?.base, system.damage.base)) ||
      (system.range && !rangeEqual(item.system?.range, system.range));

    if (differs) updates.push(patch);
  }

  if (updates.length > 0) {
    await actor.updateEmbeddedDocuments('Item', updates);
  }
  return updates;
}
