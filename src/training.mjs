// Pure, dependency-free training model for RME.
//
// Training state is represented as:
//   {
//     groups?: Record<string, 'proficient' | 'expert'>,  // keyed by exact catalog group name
//     items?: Record<string, 'untrained' | 'proficient' | 'expert'>, // keyed by exact catalog equipment id
//   }
//
// Resolution precedence (highest to lowest):
//   1. explicit item override (wins even when 'untrained')
//   2. group training
//   3. 'untrained'
//
// Natural weapons (including unarmed strike) carry no implicit level; they
// resolve to 'untrained' unless an explicit manual or derived grant raises them.
//
// This module has no Foundry globals and no data dependencies; the runtime UI
// can consume it directly.

export const LEVELS = ['untrained', 'proficient', 'expert'];

function hasOwn(record, key) {
  return Object.prototype.hasOwnProperty.call(record, key);
}

function levelOrUntrained(value) {
  return value === 'proficient' || value === 'expert' ? value : 'untrained';
}

// Resolve the training level for a single equipment entry.
export function resolveTraining(equipment, training = {}) {
  const items = training.items || {};
  const groups = training.groups || {};

  // 1. Explicit item override wins, even when set to 'untrained'.
  if (hasOwn(items, equipment.id)) {
    return levelOrUntrained(items[equipment.id]);
  }

  // 2. Group training.
  if (hasOwn(groups, equipment.group)) {
    return levelOrUntrained(groups[equipment.group]);
  }

  // 3. Untrained.
  return 'untrained';
}

// Apply a set of grants (a single source) to an existing training state,
// returning a new immutable training object. The input objects are never
// mutated.
//
//   - Duplicate item-level 'proficient' grants from separate non-multiclass
//     sources promote to 'expert'. Multiclass duplicates never promote.
//   - Duplicate group-level 'proficient' grants never promote automatically.
//   - Values never exceed 'expert' (clamped).
//   - Pre-existing explicit item overrides that are not superseded by a new
//     grant are preserved.
export function grantTraining(training = {}, grants = {}, { multiclass = false } = {}) {
  const inGroups = training.groups || {};
  const inItems = training.items || {};
  const grantGroups = grants.groups || {};
  const grantItems = grants.items || {};

  const outGroups = { ...inGroups };
  const outItems = { ...inItems };

  // Group-level grants: no automatic promotion of a duplicate martial choice.
  for (const [key, value] of Object.entries(grantGroups)) {
    if (value === 'expert') {
      outGroups[key] = 'expert';
      continue;
    }
    // 'proficient'
    const current = hasOwn(outGroups, key) ? outGroups[key] : 'untrained';
    if (current !== 'expert') {
      outGroups[key] = 'proficient';
    }
  }

  // Item-level grants: duplicate proficient from a separate source promotes to
  // expert only when not multiclass.
  for (const [key, value] of Object.entries(grantItems)) {
    if (value === 'expert') {
      outItems[key] = 'expert';
      continue;
    }
    // 'proficient'
    const current = hasOwn(outItems, key) ? levelOrUntrained(outItems[key]) : 'untrained';
    if (current === 'expert') {
      outItems[key] = 'expert';
    } else if (current === 'proficient' && !multiclass) {
      outItems[key] = 'expert';
    } else {
      outItems[key] = 'proficient';
    }
  }

  const result = {};
  if (Object.keys(outGroups).length > 0) result.groups = outGroups;
  if (Object.keys(outItems).length > 0) result.items = outItems;
  return result;
}

const TIER_LABEL_RE = /^(Untrained|Proficient|Basic|Expert)/;

function tierLabelOf(row) {
  const match = TIER_LABEL_RE.exec(row);
  return match ? match[1] : null;
}

// Map a resolved level to the set of catalog tier labels it selects. Basic and
// Proficient are equivalent in this rule set, so 'proficient' matches both.
function labelsForLevel(level) {
  if (level === 'untrained') return new Set(['Untrained']);
  if (level === 'proficient') return new Set(['Proficient', 'Basic']);
  if (level === 'expert') return new Set(['Expert']);
  return new Set();
}

// Select the tier rows that apply to an equipment entry at its resolved
// training level. rawRows contains every matching tier string from the entry
// (e.g. the Whip Sword has two forms, so two rows per level).
export function selectTier(equipment, training = {}) {
  const level = resolveTraining(equipment, training);
  const labels = labelsForLevel(level);
  const rawRows = (equipment.tiers || []).filter((row) =>
    labels.has(tierLabelOf(row))
  );

  return {
    level,
    rawRows,
    description: equipment.description,
    expertPerk: level === 'expert' ? equipment.expertPerk || null : null,
  };
}
