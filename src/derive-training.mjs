// Pure, provenance-aware automatic RME training derivation.
//
// This module derives a suggested RME training state for an actor from the
// actor's embedded class/race/feat/subclass Items. It never reads aggregate
// actor trait fields (actor.system.traits etc.) - every grant it produces is
// traced to a specific Item that carries provenance, and anything it cannot
// resolve deterministically is reported as a gap instead of being guessed.
//
// The output is:
//   {
//     training: { groups, items },   // suggested training state (levels)
//     sources: [{ id, label, type, grants }],  // one per grant-giving provider
//     gaps:    [{ sourceId, label, reason, type, count?, options? }],
//   }
//
// This module has no Foundry globals and never mutates its inputs. It only
// consumes:
//   - an actor-like `{ items: iterable, system: { details: { originalClass } } }`
//   - the RME catalog `equipment` (array of entries with id/name/kind/group/tiers)
//   - `choices`, keyed by provider Item id: `{ [id]: { groups?, items? } }`
//
// Item advancement is read from `system.advancement`, which may be an array or
// a keyed object. Trait advancements carry `configuration.grants` and
// `value.chosen` as sets/arrays of keys like `armor:lgt`, `weapon:mar`,
// `weapon:battle-axe`.

import { CLASS_IDS, classGrants, multiclassGrants, eligibleGroups } from './class-training.mjs';

// ---------------------------------------------------------------------------
// Class / rule constants (mirror rules/ClassTraining.md)
// ---------------------------------------------------------------------------

const CATEGORY_CHOICE_CLASSES = new Set(['fighter', 'barbarian', 'paladin', 'ranger']);
const MULTICLASS_CATEGORY_CHOICE_CLASSES = new Set(['barbarian', 'fighter', 'paladin', 'ranger']);

// Multiclass group restrictions differ from the single-class table (e.g.
// paladin also forbids Whips when multiclassing).
const MULTICLASS_FORBIDDEN_GROUP_BY_CLASS = {
  barbarian: ['Firearms', 'Crossbows'],
  paladin: ['Firearms', 'Throwing Weapons', 'Whips'],
  ranger: ['Polearms', 'Flails'],
};

// Same armor mapping the rest of the module uses; never re-derive from prose.
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

// The subclasses (and subclass-shaped feats) that grant expert training under
// rules/ClassTraining.md "Subclass expert Training". Keyed by normalized name.
const SUBCLASS_DESCRIPTORS = {
  armorer: 'armorer',
  arcanearcher: 'arcane-archer',
  pathofthebeast: 'beast',
  bladesinger: 'bladesinger',
  cavalier: 'cavalier',
  circleofthemoon: 'moon',
  collegeofswords: 'swords',
  eldritchknight: 'eldritch-knight',
  pactoftheblade: 'pact-blade',
  wayofthekensei: 'kensei',
  wayoftheopenhand: 'open-hand',
};

// The exact RME group expert feats (rules/ClassTraining.md and the individual
// rules/*.md files), keyed by their normalized singular name. The catalog uses
// plural group names ('Axes', 'Combat Blades'), and "Hammer and Pick expert"
// corresponds to the 'Hammers Picks' group; this map is explicit so we never
// guess from prose.
const EXPERT_FEAT_GROUP = {
  ambushweapons: 'Ambush Weapons',
  axe: 'Axes',
  bludgeon: 'Bludgeons',
  bow: 'Bows',
  combatblade: 'Combat Blades',
  crossbow: 'Crossbows',
  duelingblade: 'Dueling Blades',
  firearm: 'Firearms',
  flail: 'Flails',
  hammerandpick: 'Hammers Picks',
  polearm: 'Polearms',
  spear: 'Spears',
  throwingweapon: 'Throwing Weapons',
  whip: 'Whips',
};

// ---------------------------------------------------------------------------
// Small pure helpers
// ---------------------------------------------------------------------------

function norm(text) {
  return String(text).toLowerCase().replace(/[^a-z0-9]/g, '');
}

// Strip the tier label so a property scan never matches the label text.
function tierBody(row) {
  const match = /^(Untrained|Proficient|Basic|Expert)/.exec(row);
  return match ? row.slice(match[0].length) : row;
}

function hasProperty(entry, property) {
  const re = new RegExp(`\\b${property}\\b`);
  if (entry.kind === 'weapon' || entry.kind === 'natural') {
    return (entry.tiers || []).some((row) => re.test(tierBody(row)));
  }
  const text = (entry.tiers || []).map(tierBody).join(' ') + ' ' + (entry.description || '');
  return re.test(text);
}

function untrainedRows(entry) {
  return (entry.tiers || []).filter((row) => /^Untrained/.test(row));
}

// "Simple" definition (rules/Introduction.md): a weapon that does not carry the
// Awkward property at the Untrained tier.
function isSimpleWeapon(entry) {
  return entry.kind === 'weapon' && untrainedRows(entry).length > 0 && !untrainedIsAwkward(entry);
}

function untrainedIsAwkward(entry) {
  return untrainedRows(entry).some((row) => /\bAwkward\b/.test(tierBody(row)));
}

function isOneHandedMelee(entry) {
  return (
    entry.kind === 'weapon' &&
    (entry.tiers || []).some((row) => /\bOne-Handed\b/.test(row) && /\bMelee\b/.test(row))
  );
}

function itemId(item) {
  return item.id ?? item._id;
}

function advancementEntries(item) {
  const adv = item.system?.advancement;
  if (Array.isArray(adv)) return adv.filter(Boolean);
  if (adv && typeof adv === 'object') return Object.values(adv).filter(Boolean);
  return [];
}

function toArray(value) {
  if (Array.isArray(value)) return value;
  if (value && typeof value[Symbol.iterator] === 'function') return Array.from(value);
  return [];
}

function armorsForType(entries, type) {
  return entries.filter((e) => ARMOR_TYPE_BY_NAME[e.name] === type);
}

function hasGrants(grants) {
  return (
    grants &&
    (Object.keys(grants.groups || {}).length > 0 || Object.keys(grants.items || {}).length > 0)
  );
}

function addGroup(grants, group, level = 'proficient') {
  grants.groups[group] = level;
}

function addItem(grants, id, level = 'proficient') {
  if (id) grants.items[id] = level;
}

function higherLevel(a, b) {
  if (a === 'expert' || b === 'expert') return 'expert';
  if (a || b) return 'proficient';
  return undefined;
}

// Merge two grants objects into a fresh one, preferring the higher of any
// duplicate key (expert wins over proficient). Never mutates inputs.
function mergeGrants(a, b) {
  const groups = {};
  for (const key of new Set([...Object.keys(a.groups || {}), ...Object.keys(b.groups || {})])) {
    const level = higherLevel(a.groups?.[key], b.groups?.[key]);
    if (level) groups[key] = level;
  }
  const items = {};
  for (const key of new Set([...Object.keys(a.items || {}), ...Object.keys(b.items || {})])) {
    const level = higherLevel(a.items?.[key], b.items?.[key]);
    if (level) items[key] = level;
  }
  const out = {};
  if (Object.keys(groups).length) out.groups = groups;
  if (Object.keys(items).length) out.items = items;
  return out;
}

// ---------------------------------------------------------------------------
// Context + catalog indexes
// ---------------------------------------------------------------------------

function buildContext(equipment) {
  const weaponIds = [];
  const armorEntries = [];
  const shieldEntries = [];
  const naturalEntries = [];
  const weaponIndex = { byNormName: new Map(), byNormId: new Map() };
  const groupItems = new Map();
  const itemGroup = new Map();
  const groupHasWeapon = new Map();

  for (const entry of equipment) {
    if (!entry.id) continue;
    if (entry.group) {
      if (!groupItems.has(entry.group)) groupItems.set(entry.group, []);
      groupItems.get(entry.group).push(entry.id);
      itemGroup.set(entry.id, entry.group);
      if (entry.kind === 'weapon') groupHasWeapon.set(entry.group, true);
    }
    if (entry.kind === 'weapon') {
      weaponIds.push(entry.id);
      weaponIndex.byNormName.set(norm(entry.name), entry);
      weaponIndex.byNormId.set(norm(entry.id), entry);
    } else if (entry.kind === 'natural') {
      // Natural weapons resolve from trait keys too (e.g. `weapon:bite`).
      weaponIndex.byNormName.set(norm(entry.name), entry);
      weaponIndex.byNormId.set(norm(entry.id), entry);
      naturalEntries.push(entry);
    } else if (entry.kind === 'armor') {
      armorEntries.push(entry);
    } else if (entry.kind === 'shield') {
      shieldEntries.push(entry);
    }
  }

  const weaponGroupNorm = new Map();
  const weaponGroups = [];
  for (const [group] of groupHasWeapon) {
    weaponGroupNorm.set(norm(group), group);
    weaponGroups.push(group);
  }

  return {
    equipment,
    weaponIds,
    armorEntries,
    shieldEntries,
    naturalEntries,
    weaponIndex,
    groupItems,
    itemGroup,
    weaponGroupNorm,
    weaponGroups,
  };
}

function findWeapon(ctx, token) {
  const normalized = norm(token);
  if (ctx.weaponIndex.byNormName.has(normalized)) {
    return ctx.weaponIndex.byNormName.get(normalized);
  }
  if (ctx.weaponIndex.byNormId.has(normalized)) {
    return ctx.weaponIndex.byNormId.get(normalized);
  }
  return null;
}

// The 4-category multiclass eligible group list, from the multiclass
// restrictions (rules/ClassTraining.md). Mirrors the internal helper in
// class-training.mjs, which is not exported.
function multiclassEligibleGroups(classId, ctx) {
  const forbidden = new Set(MULTICLASS_FORBIDDEN_GROUP_BY_CLASS[classId] || []);
  return ctx.weaponGroups.filter((group) => !forbidden.has(group)).sort();
}

// The per-class property excluded from a class's chosen multiclass categories.
// Mirrors class-training.mjs (barbarian and ranger exclude Clockwork); fighter
// and paladin have no property exclusion.
const MULTICLASS_EXCLUDED_PROPERTY = {
  barbarian: 'Clockwork',
  ranger: 'Clockwork',
};

// Apply the chosen multiclass weapon categories to a grants object without
// enforcing the exact-4 count (so a partial choice can still be applied). It
// validates each category against the multiclass eligible set and the per-class
// property exclusion, and throws on a duplicate/unknown/forbidden category. It
// never guesses a category the user did not choose.
function applyMulticlassCategoryChoices(state, grants, classId, chosen) {
  const ctx = state.ctx;
  const eligible = new Set(multiclassEligibleGroups(classId, ctx));
  const excluded = MULTICLASS_EXCLUDED_PROPERTY[classId] || null;
  const seen = new Set();
  for (const group of chosen) {
    if (seen.has(group)) {
      throw new Error(`Duplicate category for ${classId}: ${group}`);
    }
    seen.add(group);
    if (!eligible.has(group)) {
      throw new Error(`Unknown or forbidden category for ${classId}: ${group}`);
    }
    if (excluded) {
      // Enumerate per-item so an excluded property never slips in by a grant.
      for (const id of ctx.groupItems.get(group) || []) {
        const entry = ctx.equipment.find((e) => e.id === id);
        if (entry && entry.kind === 'weapon' && !hasProperty(entry, excluded)) {
          addItem(grants, id, 'proficient');
        }
      }
    } else {
      addGroup(grants, group, 'proficient');
    }
  }
}

// ---------------------------------------------------------------------------
// Class identification
// ---------------------------------------------------------------------------

function classIdentifierOf(item) {
  const ci = item.system?.classIdentifier;
  if (ci && String(ci).trim()) return String(ci).toLowerCase();
  const ident = item.system?.identifier;
  if (ident && String(ident).trim()) return String(ident).toLowerCase();
  return '';
}

function originalClassId(actor) {
  const oc = actor?.system?.details?.originalClass;
  if (oc == null) return null;
  if (typeof oc === 'string') return oc.trim() || null;
  if (typeof oc === 'object' && oc.value != null && typeof oc.value === 'string') {
    return oc.value.trim() || null;
  }
  return null;
}

function findOriginalClassItem(classItems, origId) {
  if (!origId) return null;
  const byId = classItems.find((it) => itemId(it) === origId);
  if (byId) return byId;
  const folded = origId.toLowerCase();
  return classItems.find((it) => classIdentifierOf(it) === folded) || null;
}

// ---------------------------------------------------------------------------
// Choice validation (shared by subclasses and expert feats)
// ---------------------------------------------------------------------------

function validatedChoice(state, sourceId, label, chosen, allowed, { min = 1, max = 1 } = {}) {
  const valid = [];
  const invalid = [];
  for (const id of chosen) {
    if (allowed.has(id)) valid.push(id);
    else invalid.push(id);
  }
  const options = [...allowed];
  for (const id of invalid) {
    state.gaps.push({
      sourceId,
      label,
      reason: `Choice ${id} is not an allowed option.`,
      type: 'choices',
      options,
    });
  }
  if (valid.length < min) {
    state.gaps.push({
      sourceId,
      label,
      reason: `Requires at least ${min} choice(s); got ${valid.length}.`,
      type: 'choices',
      count: min,
      options,
    });
  }
  if (max !== Infinity && valid.length > max) {
    state.gaps.push({
      sourceId,
      label,
      reason: `Requires at most ${max} choice(s); got ${valid.length}.`,
      type: 'choices',
      count: max,
      options,
    });
  }
  return valid;
}

// ---------------------------------------------------------------------------
// Trait advancement parsing (race / feat)
// ---------------------------------------------------------------------------

function armorTypeFromValue(value) {
  const map = {
    lgt: 'light',
    med: 'medium',
    hvy: 'heavy',
    shl: 'shield',
    light: 'light',
    medium: 'medium',
    heavy: 'heavy',
    shield: 'shield',
  };
  return map[value] || null;
}

// Only armor/weapon-prefixed trait choice keys can grant training; a pool of
// skill/tool keys is not a weapon pool and must not raise an unselected gap.
function isWeaponKey(key) {
  const s = String(key).trim().toLowerCase();
  return s.startsWith('weapon:') || s.startsWith('weapons:');
}

// A single choice-config entry is either a legacy bare key string, or a nested
// { count, pool } entry whose pool is an array/Set of option keys. Only
// weapon-prefixed option keys count as a weapon pool; a skill/tool-only pool
// must not raise an unselected-weapon gap.
function choiceEntryHasWeaponPool(entry) {
  if (typeof entry === 'string' || typeof entry === 'number') {
    return isWeaponKey(entry);
  }
  if (entry && typeof entry === 'object' && entry.pool != null) {
    return toArray(entry.pool).some(isWeaponKey);
  }
  return false;
}

function traitHasWeaponPool(configuration) {
  const c = configuration.choices;
  if (Array.isArray(c)) {
    if (c.some(choiceEntryHasWeaponPool)) return true;
  } else if (c && c.weapons != null && toArray(c.weapons).some(isWeaponKey)) {
    return true;
  }
  if (configuration.weapons != null && toArray(configuration.weapons).some(isWeaponKey)) {
    return true;
  }
  return false;
}

function applyTraitKey(state, keyStr, grants, sourceId, label, suppressMarialGap) {
  const normalized = String(keyStr).trim().toLowerCase();
  let kind;
  let value;
  if (normalized.startsWith('armor:')) {
    kind = 'armor';
    value = normalized.slice(6);
  } else if (normalized.startsWith('weapons:')) {
    kind = 'weapon';
    value = normalized.slice(8);
  } else if (normalized.startsWith('weapon:')) {
    kind = 'weapon';
    value = normalized.slice(7);
  } else {
    // Not an armor/weapon grant (e.g. a tool or skill key) - ignored.
    return;
  }

  if (kind === 'armor') {
    const type = armorTypeFromValue(value);
    if (!type) {
      state.gaps.push({
        sourceId,
        label,
        reason: `Unknown armor trait key ${keyStr}.`,
        type: 'armor',
      });
      return;
    }
    if (type === 'shield') {
      for (const entry of state.ctx.shieldEntries) addItem(grants, entry.id, 'proficient');
    } else {
      for (const entry of armorsForType(state.ctx.armorEntries, type)) {
        addItem(grants, entry.id, 'proficient');
      }
    }
    return;
  }

  // weapon
  if (value === 'mar') {
    // A generic martial grant means "any weapon category"; the caller decides
    // how to surface it. A race/feat reports it as a plain unknown-weapon gap;
    // a subclass reports an 8-category choice gap instead, so suppress the
    // generic gap there (processItems passes suppressMarialGap).
    if (!suppressMarialGap) {
      state.gaps.push({
        sourceId,
        label,
        reason: 'Generic martial weapon training (weapon:mar); no RME group inferred.',
        type: 'weapon',
      });
    }
    return;
  }
  if (value === 'sim') {
    for (const entry of state.ctx.equipment) {
      if (isSimpleWeapon(entry)) addItem(grants, entry.id, 'proficient');
    }
    return;
  }
  const entry = findWeapon(state.ctx, value);
  if (!entry) {
    state.gaps.push({
      sourceId,
      label,
      reason: `Unknown weapon trait key ${keyStr}.`,
      type: 'weapon',
    });
    return;
  }
  addItem(grants, entry.id, 'proficient');
}

function deriveTraitGrants(state, item, options = {}) {
  const suppressMarialGap = Boolean(options.suppressMarialGap);
  const grants = { groups: {}, items: {} };
  const sourceId = itemId(item);
  const label = item.name || 'Trait';
  let hasUnselectedPool = false;

  for (const entry of advancementEntries(item)) {
    const advType = String(entry.type || '').toLowerCase();
    if (advType !== 'trait' && advType !== 'traits') continue;
    const configuration = entry.configuration || {};
    const value = entry.value || {};
    const grantKeys = toArray(configuration.grants);
    const chosenKeys = toArray(value.chosen);

    if (traitHasWeaponPool(configuration) && chosenKeys.length === 0) {
      hasUnselectedPool = true;
    }

    const seen = new Set();
    for (const keyStr of [...grantKeys, ...chosenKeys]) {
      if (seen.has(keyStr)) continue;
      seen.add(keyStr);
      applyTraitKey(state, keyStr, grants, sourceId, label, suppressMarialGap);
    }
  }

  if (hasUnselectedPool) {
    state.gaps.push({
      sourceId,
      label,
      reason: 'A Trait weapon choice is unselected; no weapons granted until one is chosen.',
      type: 'choices',
      options: state.ctx.weaponIds.slice(),
    });
  }

  return grants;
}

// ---------------------------------------------------------------------------
// Subclass expert training
// ---------------------------------------------------------------------------

function subclassDescriptor(normName) {
  return SUBCLASS_DESCRIPTORS[normName] || null;
}

function subclassGrants(state, item) {
  const key = itemId(item);
  const label = item.name || 'Subclass';
  const normName = norm(item.name || '');
  const sub = subclassDescriptor(normName);
  if (!sub) return null; // not a known expert-training subclass: ignored (no guess)

  const grants = { groups: {}, items: {} };
  const chosen = () => state.choices[key]?.items || [];
  const ctx = state.ctx;

  switch (sub) {
    case 'armorer': {
      // Heavy armor expert, plus 1 shield of choice.
      for (const entry of armorsForType(ctx.armorEntries, 'heavy')) {
        addItem(grants, entry.id, 'expert');
      }
      const shieldSet = new Set(ctx.shieldEntries.map((e) => e.id));
      const valid = validatedChoice(state, key, label, chosen(), shieldSet, { min: 1, max: 1 });
      for (const id of valid) addItem(grants, id, 'expert');
      break;
    }

    case 'arcane-archer': {
      addGroup(grants, 'Bows', 'expert');
      addGroup(grants, 'Crossbows', 'expert');
      break;
    }

    case 'beast': {
      for (const id of ['natural-weapons/bite', 'natural-weapons/claw', 'natural-weapons/tail']) {
        addItem(grants, id, 'expert');
      }
      break;
    }

    case 'bladesinger': {
      const oneHanded = new Set(
        ctx.equipment.filter((e) => isOneHandedMelee(e)).map((e) => e.id)
      );
      const valid = validatedChoice(state, key, label, chosen(), oneHanded, { min: 1, max: 1 });
      for (const id of valid) addItem(grants, id, 'expert');
      break;
    }

    case 'cavalier': {
      addItem(grants, 'spears/lance', 'expert');
      break;
    }

    case 'moon': {
      for (const entry of ctx.naturalEntries) {
        if (entry.id !== 'natural-weapons/unarmed-strike') addItem(grants, entry.id, 'expert');
      }
      break;
    }

    case 'swords': {
      const combatBlades = new Set(
        ctx.equipment
          .filter((e) => e.group === 'Combat Blades' && isOneHandedMelee(e))
          .map((e) => e.id)
      );
      const valid = validatedChoice(state, key, label, chosen(), combatBlades, { min: 1, max: 1 });
      for (const id of valid) addItem(grants, id, 'expert');
      break;
    }

    case 'eldritch-knight': {
      const allWeapons = new Set(ctx.weaponIds);
      const valid = validatedChoice(state, key, label, chosen(), allWeapons, { min: 1, max: 1 });
      for (const id of valid) addItem(grants, id, 'expert');
      break;
    }

    case 'pact-blade': {
      const simple = new Set(ctx.equipment.filter((e) => isSimpleWeapon(e)).map((e) => e.id));
      const valid = validatedChoice(state, key, label, chosen(), simple, { min: 1, max: 1 });
      for (const id of valid) addItem(grants, id, 'expert');
      break;
    }

    case 'kensei': {
      const allWeapons = new Set(ctx.weaponIds);
      const valid = validatedChoice(state, key, label, chosen(), allWeapons, {
        min: 1,
        max: Infinity,
      });
      for (const id of valid) addItem(grants, id, 'expert');
      break;
    }

    case 'open-hand': {
      const natural = new Set(ctx.naturalEntries.map((e) => e.id));
      const valid = validatedChoice(state, key, label, chosen(), natural, { min: 1, max: 1 });
      for (const id of valid) addItem(grants, id, 'expert');
      break;
    }

    default:
      return null;
  }

  return grants;
}

// The empty grants object used when a subclass has no known name-based
// descriptor; keeps mergeGrants call sites safe.
const EMPTY_GRANTS = { groups: {}, items: {} };

// Does a subclass item carry a generic martial-proficiency Trait grant
// (weapon:mar / weapons:mar) in configuration.grants or value.chosen? A subclass
// that grants martial proficiency instead awards basic training in a choice of 8
// weapon categories (rules/ClassTraining.md "Subclass expert Training"), so it
// must be surfaced as an 8-category choice rather than an unknown weapon gap.
function subclassHasMartialGrant(item) {
  for (const entry of advancementEntries(item)) {
    const advType = String(entry.type || '').toLowerCase();
    if (advType !== 'trait' && advType !== 'traits') continue;
    const configuration = entry.configuration || {};
    const value = entry.value || {};
    for (const keyStr of [...toArray(configuration.grants), ...toArray(value.chosen)]) {
      const s = String(keyStr).trim().toLowerCase();
      if (s === 'weapon:mar' || s === 'weapons:mar') return true;
    }
  }
  return false;
}

// Apply a subclass's generic martial proficiency (weapon:mar). The 8-category
// choice is validated against the unrestricted fighter-eligible weapon groups (a
// subclass martial grant has no group restrictions beyond being a weapon
// category). Valid chosen categories are applied as proficient group grants;
// absent, partial or invalid (unknown/duplicate) choices are reported as a
// single groups gap so the UI can prompt for the selection. It never guesses a
// category the user did not choose, and never emits more than one gap for a
// single subclass martial source.
function applySubclassMartialChoice(state, item, grants) {
  // mergeGrants may return an empty object, so ensure the grant buckets exist
  // before adding any group.
  if (!grants.groups) grants.groups = {};
  if (!grants.items) grants.items = {};
  const key = itemId(item);
  const label = item.name || 'Subclass';
  const options = eligibleGroups('fighter', state.ctx.equipment);
  const provided = state.choices[key]?.groups;
  const chosen = Array.isArray(provided) ? provided : [];
  const eligible = new Set(options);

  const valid = [];
  const invalid = [];
  const seen = new Set();
  for (const group of chosen) {
    if (seen.has(group)) {
      invalid.push(group);
      continue;
    }
    seen.add(group);
    if (eligible.has(group)) valid.push(group);
    else invalid.push(group);
  }

  for (const group of valid) addGroup(grants, group, 'proficient');

  if (valid.length !== 8 || invalid.length > 0) {
    state.gaps.push({
      sourceId: key,
      label,
      reason: 'Subclass martial proficiency requires 8 RME category choices',
      type: 'groups',
      count: 8,
      options,
    });
  }

  return grants;
}

// ---------------------------------------------------------------------------
// Expert feats (named '<group> expert' / 'Weapon expert')
// ---------------------------------------------------------------------------

function expertFeatDescriptor(state, normName) {
  if (normName === 'weaponexpert') return { all: true };
  if (!normName.endsWith('expert')) return null;
  const prefix = normName.slice(0, -'expert'.length);
  if (Object.prototype.hasOwnProperty.call(EXPERT_FEAT_GROUP, prefix)) {
    return { group: EXPERT_FEAT_GROUP[prefix] };
  }
  // Also accept the exact plural catalog group name in the feat name.
  for (const [normGroup, group] of state.ctx.weaponGroupNorm) {
    if (prefix === normGroup) return { group };
  }
  return { unknown: true };
}

function expertFeatGrants(state, item, descriptor) {
  const key = itemId(item);
  const label = item.name || 'Feat';
  const ctx = state.ctx;
  const allowed = descriptor.all
    ? new Set(ctx.weaponIds)
    : new Set(ctx.groupItems.get(descriptor.group) || []);
  const chosen = state.choices[key]?.items || [];

  const valid = [];
  const invalid = [];
  for (const id of chosen) {
    if (allowed.has(id)) valid.push(id);
    else invalid.push(id);
  }

  const options = [...allowed];
  for (const id of invalid) {
    state.gaps.push({
      sourceId: key,
      label,
      reason: `Choice ${id} is not a valid ${descriptor.all ? 'weapon' : descriptor.group} expert option.`,
      type: 'choices',
      options,
    });
  }
  if (valid.length !== 4) {
    state.gaps.push({
      sourceId: key,
      label,
      reason: `${label} requires exactly 4 chosen items; got ${valid.length}.`,
      type: 'choices',
      count: 4,
      options,
    });
  }

  const grants = { groups: {}, items: {} };
  for (const id of valid) addItem(grants, id, 'expert');
  return grants;
}

// ---------------------------------------------------------------------------
// Source tracking
// ---------------------------------------------------------------------------

function addSource(state, type, item, grants, multiclass) {
  if (!hasGrants(grants)) return null;
  const source = {
    id: itemId(item),
    label: item.name || type,
    type,
    grants,
    multiclass,
  };
  state.sources.push(source);
  return source;
}

// ---------------------------------------------------------------------------
// Class processing
// ---------------------------------------------------------------------------

// A homebrew/unknown class (or a class Item with no identifier) cannot be
// resolved by classGrants/multiclassGrants, which would throw. Surface it as a
// manual gap so it stays visible, and never call the grant builders.
function pushUnsupportedClassGap(state, classItem, classId) {
  const identifier = classId || '(missing)';
  state.gaps.push({
    sourceId: itemId(classItem),
    label: classItem.name || identifier,
    reason: `Unsupported class identifier ${identifier}; assign RME training manually.`,
    type: 'manual',
  });
}

// Is a class Trait key superseded by the RME ClassTraining table? Generic
// class Trait keys (weapon:sim, weapon:mar, armor:lgt|med|hvy|shl and their
// long forms) are superseded because every class's base table already grants
// the corresponding simple/martial/armor training; they are ignored (no grant,
// no gap).
function isGenericClassTraitKey(normalized) {
  if (normalized === 'weapon:sim' || normalized === 'weapons:sim') return true;
  if (normalized === 'weapon:mar' || normalized === 'weapons:mar') return true;
  if (normalized.startsWith('armor:')) {
    return armorTypeFromValue(normalized.slice(6)) != null;
  }
  return false;
}

// Apply one class Trait key. Specific weapon/armor grants are recorded; generic
// class keys are ignored; any other unknown weapon/armor key surfaces as a
// manual-review gap rather than being silently dropped.
function applyClassTraitKey(state, keyStr, grants, sourceId, label) {
  const normalized = String(keyStr).trim().toLowerCase();
  let kind;
  let value;
  if (normalized.startsWith('armor:')) {
    kind = 'armor';
    value = normalized.slice(6);
  } else if (normalized.startsWith('weapons:')) {
    kind = 'weapon';
    value = normalized.slice(8);
  } else if (normalized.startsWith('weapon:')) {
    kind = 'weapon';
    value = normalized.slice(7);
  } else {
    // Not an armor/weapon grant (e.g. a tool or skill key) - ignored.
    return;
  }

  if (isGenericClassTraitKey(normalized)) return;

  if (kind === 'armor') {
    // A non-generic armor key is not a known armor-type grant: manual review.
    state.gaps.push({
      sourceId,
      label,
      reason: `Unknown class Trait key ${keyStr}; manual review required.`,
      type: 'manual',
    });
    return;
  }

  const entry = findWeapon(state.ctx, value);
  if (!entry) {
    state.gaps.push({
      sourceId,
      label,
      reason: `Unknown class Trait key ${keyStr}; manual review required.`,
      type: 'manual',
    });
    return;
  }
  addItem(grants, entry.id, 'proficient');
}

// Parse the specific weapon/armor Trait grants/chosen carried by a class Item
// (original or multiclass). These are merged into the SAME provider source as
// the RME class table grants so a single class can never promote itself. It
// never invents a selection: only explicit, completed specific grants/chosen
// produce item grants, an unselected weapon choice surfaces as a gap, and
// unknown weapon/armor keys surface as manual-review gaps.
function classTraitGrants(state, item, original = false) {
  const grants = { groups: {}, items: {} };
  const sourceId = itemId(item);
  const label = item.name || 'Class';
  let hasUnselectedPool = false;

  for (const entry of advancementEntries(item)) {
    const advType = String(entry.type || '').toLowerCase();
    if (advType !== 'trait' && advType !== 'traits') continue;

    // A class Trait may be gated to a specific class level or to the original /
    // multiclass slot. Skip any Trait that cannot apply to the current class Item
    // before deriving grants; never read `value` for level gating. When either the
    // Trait's `level` or the actor's class `levels` is absent (not a finite
    // number), the Trait is treated as applicable (current behavior, no gap).
    const entryLevel = Number(entry.level);
    const classLevels = Number(item.system?.levels);
    if (Number.isFinite(entryLevel) && Number.isFinite(classLevels) && entryLevel > classLevels) {
      continue;
    }
    const restriction = entry.classRestriction;
    if (restriction === 'primary' && !original) continue;
    if (restriction === 'secondary' && original) continue;

    const configuration = entry.configuration || {};
    const value = entry.value || {};
    const grantKeys = toArray(configuration.grants);
    const chosenKeys = toArray(value.chosen);

    if (traitHasWeaponPool(configuration) && chosenKeys.length === 0) {
      hasUnselectedPool = true;
    }

    const seen = new Set();
    for (const keyStr of [...grantKeys, ...chosenKeys]) {
      if (seen.has(keyStr)) continue;
      seen.add(keyStr);
      applyClassTraitKey(state, keyStr, grants, sourceId, label);
    }
  }

  if (hasUnselectedPool) {
    state.gaps.push({
      sourceId,
      label,
      reason: 'A class Trait weapon choice is unselected; no specific weapon granted.',
      type: 'choices',
      options: state.ctx.weaponIds.slice(),
    });
  }

  return grants;
}

function processOriginalClass(state, classItem) {
  const classId = classIdentifierOf(classItem);
  const key = itemId(classItem);
  const label = classItem.name || classId;
  const traitGrants = classTraitGrants(state, classItem, true);
  if (!classId || !CLASS_IDS.includes(classId)) {
    pushUnsupportedClassGap(state, classItem, classId);
    if (hasGrants(traitGrants)) addSource(state, 'class', classItem, traitGrants, false);
    return;
  }

  const isCategory = CATEGORY_CHOICE_CLASSES.has(classId);
  const provided = state.choices[key]?.groups;
  const chosen = Array.isArray(provided) ? provided : [];
  const options = eligibleGroups(classId, state.ctx.equipment);

  if (isCategory) {
    if (chosen.length === 0) {
      // Missing 8-category choice: apply only the fixed armor/simple grants and
      // report the gap (never silently pick groups).
      const grants = classGrants(classId, state.ctx.equipment, []);
      addSource(state, 'class', classItem, mergeGrants(grants, traitGrants), false);
      state.gaps.push({
        sourceId: key,
        label,
        reason: 'No weapon categories chosen; only fixed armor/simple training applied.',
        type: 'groups',
        count: 8,
        options,
      });
      return;
    }
    if (chosen.length !== 8) {
      // A partial choice must not be treated as complete: report a gap but keep
      // the valid grants the chosen categories already confer (no guessing the
      // missing ones).
      let grants;
      let error = null;
      try {
        grants = classGrants(classId, state.ctx.equipment, chosen);
      } catch (caught) {
        grants = classGrants(classId, state.ctx.equipment, []);
        error = caught;
      }
      addSource(state, 'class', classItem, mergeGrants(grants, traitGrants), false);
      if (error) {
        state.gaps.push({
          sourceId: key,
          label,
          reason: error.message,
          type: 'groups',
          count: 8,
          options,
        });
      }
      state.gaps.push({
        sourceId: key,
        label,
        reason: `Expected exactly 8 weapon categories; got ${chosen.length}.`,
        type: 'groups',
        count: 8,
        options,
      });
      return;
    }
  }

  let grants;
  try {
    grants = classGrants(classId, state.ctx.equipment, chosen);
  } catch (error) {
    grants = classGrants(classId, state.ctx.equipment, []);
    state.gaps.push({
      sourceId: key,
      label,
      reason: error.message,
      type: 'groups',
      count: 8,
      options: eligibleGroups(classId, state.ctx.equipment),
    });
  }
  addSource(state, 'class', classItem, mergeGrants(grants, traitGrants), false);
}

function processMulticlassClass(state, classItem) {
  const classId = classIdentifierOf(classItem);
  const key = itemId(classItem);
  const label = classItem.name || classId;
  const traitGrants = classTraitGrants(state, classItem, false);
  if (!classId || !CLASS_IDS.includes(classId)) {
    pushUnsupportedClassGap(state, classItem, classId);
    if (hasGrants(traitGrants)) addSource(state, 'class', classItem, traitGrants, true);
    return;
  }

  const isCategory = MULTICLASS_CATEGORY_CHOICE_CLASSES.has(classId);
  const provided = state.choices[key]?.groups;
  const chosen = Array.isArray(provided) ? provided : [];
  const options = multiclassEligibleGroups(classId, state.ctx);

  if (isCategory && chosen.length === 0) {
    const grants = multiclassGrants(classId, state.ctx.equipment, []);
    addSource(state, 'class', classItem, mergeGrants(grants, traitGrants), true);
    state.gaps.push({
      sourceId: key,
      label,
      reason: 'No multiclass weapon categories chosen; only fixed grants applied.',
      type: 'groups',
      count: 4,
      options,
    });
    return;
  }

  if (isCategory && chosen.length !== 4) {
    // A partial multiclass choice must not be silently dropped as complete: report
    // a gap, but preserve the valid grants the already-chosen categories confer
    // (no guessing the missing categories).
    const grants = multiclassGrants(classId, state.ctx.equipment, []);
    let error = null;
    try {
      applyMulticlassCategoryChoices(state, grants, classId, chosen);
    } catch (caught) {
      error = caught;
    }
    addSource(state, 'class', classItem, mergeGrants(grants, traitGrants), true);
    if (error) {
      state.gaps.push({
        sourceId: key,
        label,
        reason: error.message,
        type: 'groups',
        count: 4,
        options,
      });
    }
    state.gaps.push({
      sourceId: key,
      label,
      reason: `Expected exactly 4 multiclass weapon categories; got ${chosen.length}.`,
      type: 'groups',
      count: 4,
      options,
    });
    return;
  }

  let grants;
  try {
    grants = multiclassGrants(classId, state.ctx.equipment, chosen);
  } catch (error) {
    grants = multiclassGrants(classId, state.ctx.equipment, []);
    state.gaps.push({
      sourceId: key,
      label,
      reason: error.message,
      type: 'groups',
      count: 4,
      options: multiclassEligibleGroups(classId, state.ctx),
    });
  }
  addSource(state, 'class', classItem, mergeGrants(grants, traitGrants), true);
}

function processClassItems(state, actor) {
  const classItems = [];
  for (const item of actor.items) {
    if (item.type === 'class') classItems.push(item);
  }
  if (classItems.length === 0) return;

  const origId = originalClassId(actor);
  let originalItem = null;

  if (origId) {
    originalItem = findOriginalClassItem(classItems, origId);
    if (!originalItem) {
      // Original class id references an item that is not present; do not guess.
      state.gaps.push({
        sourceId: origId,
        label: `Original class ${origId}`,
        reason: 'Referenced original class item not found on the actor.',
        type: 'classes',
      });
    }
  } else if (classItems.length === 1) {
    originalItem = classItems[0];
  } else {
    state.gaps.push({
      sourceId: null,
      label: 'Classes',
      reason: 'Multiple classes with no original class set; treating all as multiclass.',
      type: 'classes',
    });
  }

  for (const classItem of classItems) {
    if (originalItem && classItem === originalItem) {
      processOriginalClass(state, classItem);
    } else {
      processMulticlassClass(state, classItem);
    }
  }
}

// ---------------------------------------------------------------------------
// Item dispatch
// ---------------------------------------------------------------------------

function processItems(state, actor) {
  for (const item of actor.items) {
    if (item.type === 'class') continue; // handled together (original vs multiclass)
    if (item.type === 'race') {
      const grants = deriveTraitGrants(state, item);
      if (hasGrants(grants)) addSource(state, 'race', item, grants, false);
    } else if (item.type === 'subclass') {
      // One provider contributes exactly one source: merge any Trait-advancement
      // grants with the known name-based subclass grants. A martial-proficiency
      // Trait grant is surfaced as an 8-category choice rather than the generic
      // unknown-weapon gap.
      const hasMartial = subclassHasMartialGrant(item);
      const traitGrants = deriveTraitGrants(state, item, { suppressMarialGap: hasMartial });
      const subGrants = subclassGrants(state, item);
      const merged = mergeGrants(traitGrants, subGrants || EMPTY_GRANTS);
      const grants = hasMartial ? applySubclassMartialChoice(state, item, merged) : merged;
      if (hasGrants(grants)) addSource(state, 'subclass', item, grants, false);
    } else if (item.type === 'feat') {
      // One provider contributes exactly one source: merge any Trait-advancement
      // grants with the name-based subclass / expert-feat grants.
      const traitGrants = deriveTraitGrants(state, item);

      const normName = norm(item.name || '');
      const sub = subclassDescriptor(normName);
      if (sub) {
        // Feat matching a known subclass name is treated as that subclass.
        const subGrants = subclassGrants(state, item);
        const grants = mergeGrants(traitGrants, subGrants);
        if (hasGrants(grants)) addSource(state, 'feat', item, grants, false);
        continue;
      }
      const expert = expertFeatDescriptor(state, normName);
      if (expert) {
        if (expert.unknown) {
          state.gaps.push({
            sourceId: itemId(item),
            label: item.name || 'Feat',
            reason: `Unrecognized expert feat: ${item.name} (manual review).`,
            type: 'manual',
          });
          if (hasGrants(traitGrants)) addSource(state, 'feat', item, traitGrants, false);
        } else {
          const expertGrants = expertFeatGrants(state, item, expert);
          const grants = mergeGrants(traitGrants, expertGrants);
          if (hasGrants(grants)) addSource(state, 'feat', item, grants, false);
        }
        continue;
      }
      // Suspicious training feat we cannot infer from prose.
      if (/expert|proficien/i.test(item.name || '')) {
        state.gaps.push({
          sourceId: itemId(item),
          label: item.name || 'Feat',
          reason: `Unrecognized training feat: ${item.name} (manual review).`,
          type: 'manual',
        });
        if (hasGrants(traitGrants)) addSource(state, 'feat', item, traitGrants, false);
        continue;
      }
      // Otherwise an irrelevant feat: keep any Trait grants, ignore the rest.
      if (hasGrants(traitGrants)) addSource(state, 'feat', item, traitGrants, false);
    }
  }
}

// ---------------------------------------------------------------------------
// Aggregation
// ---------------------------------------------------------------------------

function aggregateSources(sources, ctx) {
  const groupLevel = new Map();
  const itemState = new Map();

  const ensure = (id) => {
    let state = itemState.get(id);
    if (!state) {
      state = { nonMc: new Set(), anyProf: false, anyExpert: false, direct: false };
      itemState.set(id, state);
    }
    return state;
  };

  sources.forEach((src) => {
    const multiclass = Boolean(src.multiclass);
    const groupGrants = src.grants?.groups || {};
    const itemGrants = src.grants?.items || {};

    for (const [group, level] of Object.entries(groupGrants)) {
      const lvl = level === 'expert' ? 'expert' : 'proficient';
      const current = groupLevel.get(group);
      if (lvl === 'expert') groupLevel.set(group, 'expert');
      else if (!current || current !== 'expert') groupLevel.set(group, 'proficient');

      for (const id of ctx.groupItems.get(group) || []) {
        const item = ensure(id);
        if (lvl === 'expert') item.anyExpert = true;
        else if (!multiclass) item.nonMc.add(src.id);
        item.anyProf = true;
      }
    }

    for (const [id, level] of Object.entries(itemGrants)) {
      const item = ensure(id);
      item.direct = true;
      if (level === 'expert') item.anyExpert = true;
      else if (!multiclass) item.nonMc.add(src.id);
      item.anyProf = true;
    }
  });

  const outGroups = {};
  for (const [group, level] of groupLevel) outGroups[group] = level;

  const outItems = {};
  for (const [id, item] of itemState) {
    let level;
    if (item.anyExpert) level = 'expert';
    else if (item.nonMc.size >= 2) level = 'expert';
    else if (item.anyProf) level = 'proficient';
    else continue;

    const coveringGroup = ctx.itemGroup.get(id);
    if (!coveringGroup) {
      outItems[id] = level;
      continue;
    }
    const groupDerived = groupLevel.get(coveringGroup); // 'expert' | 'proficient' | undefined

    if (groupDerived === 'expert') {
      // A group expert grant covers this item at expert; emit the item as expert
      // (never let a lower direct proficient grant downgrade the effective
      // expert level), and only when it is itself explicitly granted (provenance
      // clarity).
      if (!item.direct) continue;
      outItems[id] = 'expert';
    } else if (groupDerived === 'proficient') {
      // A group proficient grant covers the item at the same level; emit it only
      // when a specific source promoted/flagged it beyond the group.
      if (level === 'proficient' && !item.direct) continue;
      outItems[id] = level;
    } else {
      // No covering group grant: emit the item-level result.
      outItems[id] = level;
    }
  }

  return { groups: outGroups, items: outItems };
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

// Derive a suggested RME training state from the actor's embedded class, race
// feat and subclass Items. Returns `{ training, sources, gaps }` and never
// mutates any input.
export function deriveActorTraining(actor, equipment, choices = {}) {
  const ctx = buildContext(equipment);
  const state = { sources: [], gaps: [], choices: choices || {}, ctx };

  processClassItems(state, actor);
  processItems(state, actor);

  const training = aggregateSources(state.sources, ctx);

  const sources = state.sources.map(({ multiclass, ...rest }) => ({ ...rest }));
  const gaps = state.gaps.map((gap) => ({ ...gap }));

  return { training, sources, gaps };
}
