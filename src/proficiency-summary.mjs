// Foundry-neutral summary of effective RME armor/weapon proficiencies for the
// dnd5e actor sheet.
//
// This module has no Foundry globals and never mutates its inputs. It reads a
// catalog `equipment` iterable and the actor-training picture produced by
// `computeActorTraining`, then groups catalog entries into effective proficiency
// categories:
//   - Armor is split by the exported `ARMOR_TYPE_BY_NAME` map into Light Armor,
//     Medium Armor, Heavy Armor, and shields into a Shields category. Armor whose
//     name is not in that map is reported as an individual item row.
//   - Weapons are grouped by their catalog `entry.group`, including Natural
//     Weapons.
//
// For each group a category baseline is chosen only when it is trustworthy:
//   (a) every member is at the same positive level, or
//   (b) the effective manual/derived group level is positive (manual explicit
//       untrained suppresses derived) and at least one member is positive.
//
// Natural Weapons get a default baseline only when no explicit group level
// exists and every non-unarmed member is at least proficient (proficient, or
// expert when all seven are expert), listing Unarmed Strike as an untrained
// exception when applicable.
//
// When no reliable baseline exists the group emits only its positive individual
// rows. A category never appears with all members untrained, untrained members
// are never top-level, and specific expert items are preserved under a
// proficient category (and specific proficient items under an expert category)
// as an indented item row with its actual level.
//
// "Basic" is not "Proficient": a Basic item is nonpositive, so it never counts
// toward a category baseline and is never shown as a positive top-level or
// indented item. Under a positive category it is reported only as a 'basic'
// exception (never relabeled 'untrained').

import { ARMOR_TYPE_BY_NAME } from './items.mjs';

const NATURAL_GROUP_KEY = 'Natural Weapons';
const UNARMED_ID = 'natural-weapons/unarmed-strike';
const SHIELD_GROUP_KEY = 'Shields';
const ARMOR_BASELINE_KEY = 'Armor';
const ARMOR_CATEGORY_BY_TYPE = {
  light: 'Light Armor',
  medium: 'Medium Armor',
  heavy: 'Heavy Armor',
};

function hasOwn(record, key) {
  return Object.prototype.hasOwnProperty.call(record, key);
}

function normalizeLevel(value) {
  if (value === 'proficient' || value === 'expert') return value;
  if (value === 'basic') return 'basic';
  return 'untrained';
}

function isPositive(level) {
  return level === 'proficient' || level === 'expert';
}

function compareStrings(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

function effectiveGroupLevel(key, manual, derived) {
  const mGroups = manual.groups || {};
  const dGroups = derived.groups || {};
  if (hasOwn(mGroups, key)) return normalizeLevel(mGroups[key]);
  if (hasOwn(dGroups, key)) return normalizeLevel(dGroups[key]);
  return null;
}

// Build the armor / weapon group buckets and the list of armor entries that are
// not covered by the armor-name map (reported individually).
function buildGroups(equipment) {
  const armorGroups = new Map();
  const weaponGroups = new Map();
  const armorIndividual = [];

  for (const entry of equipment) {
    if (entry.kind === 'armor') {
      const label = ARMOR_CATEGORY_BY_TYPE[ARMOR_TYPE_BY_NAME[entry.name]];
      if (label) {
        addToGroups(armorGroups, label, ARMOR_BASELINE_KEY, entry);
      } else {
        armorIndividual.push(entry);
      }
    } else if (entry.kind === 'shield') {
      addToGroups(armorGroups, SHIELD_GROUP_KEY, SHIELD_GROUP_KEY, entry);
    } else if (entry.kind === 'weapon' || entry.kind === 'natural') {
      addToGroups(weaponGroups, entry.group, entry.group, entry);
    }
  }

  return { armorGroups, weaponGroups, armorIndividual };
}

function addToGroups(groups, label, baselineKey, entry) {
  let group = groups.get(label);
  if (!group) {
    group = { label, baselineKey, entries: [] };
    groups.set(label, group);
  }
  group.entries.push(entry);
}

// Collect members for a group, de-duplicating by catalog id so a repeated entry
// in the input can never produce a duplicate exception or item row.
function collectMembers(entries, effective) {
  const seen = new Set();
  const members = [];
  for (const entry of entries) {
    if (seen.has(entry.id)) continue;
    seen.add(entry.id);
    members.push({ entry, level: normalizeLevel(effective[entry.id]) });
  }
  return members;
}

// Choose the category baseline for a group, or null when no reliable category
// exists (the caller then emits only positive individual rows).
function chooseBaseline(members, baselineKey, manual, derived) {
  const counts = {};
  let positiveCount = 0;
  for (const member of members) {
    if (isPositive(member.level)) {
      positiveCount += 1;
      counts[member.level] = (counts[member.level] || 0) + 1;
    }
  }

  // A positive category is never shown when every member is untrained.
  if (positiveCount === 0) return null;

  // (a) Every member is at the same positive level.
  if (positiveCount === members.length && Object.keys(counts).length === 1) {
    return Object.keys(counts)[0];
  }

  // Natural Weapons default: only with no explicit group and every non-unarmed
  // member at least proficient, choose proficient (or expert when all seven are
  // expert); Unarmed Strike is handled as an exception by the caller.
  const noExplicitGroup =
    !hasOwn((manual.groups || {}), baselineKey) &&
    !hasOwn((derived.groups || {}), baselineKey);
  if (baselineKey === NATURAL_GROUP_KEY && noExplicitGroup) {
    const nonUnarmed = members.filter((m) => m.entry.id !== UNARMED_ID);
    if (nonUnarmed.length > 0 && nonUnarmed.every((m) => isPositive(m.level))) {
      return nonUnarmed.every((m) => m.level === 'expert') ? 'expert' : 'proficient';
    }
  }

  // (b) An effective positive group level (manual precedence, explicit manual
  // untrained suppresses derived) with at least one positive member.
  const groupLevel = effectiveGroupLevel(baselineKey, manual, derived);
  if (isPositive(groupLevel) && positiveCount >= 1) {
    return groupLevel;
  }

  return null;
}

// Build the output blocks for a group. A returned array is empty when the group
// has nothing positive to show; a single block carries either a category row
// plus its positive-exception item rows, or one standalone item row per positive
// member when no category baseline exists.
function summarizeGroup(group, effective, manual, derived) {
  const members = collectMembers(group.entries, effective);
  const baseline = chooseBaseline(members, group.baselineKey, manual, derived);

  if (baseline === null) {
    const blocks = [];
    for (const member of members) {
      if (isPositive(member.level)) {
        blocks.push({
          sortLabel: member.entry.name,
          kind: 'item',
          rows: [{ kind: 'item', label: member.entry.name, level: member.level }],
        });
      }
    }
    return blocks;
  }

  const exceptions = [];
  const itemRows = [];
  for (const member of members) {
    if (member.level !== baseline) {
      exceptions.push({ label: member.entry.name, level: member.level });
      if (isPositive(member.level)) {
        itemRows.push({ kind: 'item', label: member.entry.name, level: member.level });
      }
    }
  }
  exceptions.sort((a, b) => compareStrings(a.label, b.label));
  itemRows.sort((a, b) => compareStrings(a.label, b.label));

  const categoryRow = { kind: 'category', label: group.label, level: baseline, exceptions };
  return [{ sortLabel: group.label, kind: 'category', rows: [categoryRow, ...itemRows] }];
}

// Build standalone item blocks for armor entries not covered by the armor-name
// map. Untrained items are never top-level.
function individualBlocks(entries, effective) {
  const blocks = [];
  for (const entry of entries) {
    const level = normalizeLevel(effective[entry.id]);
    if (!isPositive(level)) continue;
    blocks.push({
      sortLabel: entry.name,
      kind: 'item',
      rows: [{ kind: 'item', label: entry.name, level }],
    });
  }
  return blocks;
}

// Sort blocks alphabetically by their sort label, breaking ties so a category
// block precedes a standalone item block with the same label, then flatten into
// the row list. A category block stays together with its indented item rows.
function finalize(blocks) {
  blocks.sort((a, b) => {
    const byLabel = compareStrings(a.sortLabel, b.sortLabel);
    if (byLabel !== 0) return byLabel;
    const byKind = a.kind === 'category' ? 0 : 1;
    const otherKind = b.kind === 'category' ? 0 : 1;
    return byKind - otherKind;
  });
  const rows = [];
  for (const block of blocks) rows.push(...block.rows);
  return rows;
}

// Summarize the effective RME armor and weapon proficiencies for an actor sheet.
//
// `equipment` is an iterable of catalog entries; `picture` is the result of
// `computeActorTraining` and must expose `effective.items` (the per-item
// effective level map), plus the optional `manual` / `derived` group states used
// to honor manual-overrides-automation precedence. No input is mutated and no
// Foundry global is touched.
export function summarizeRmeProficiencies(equipment, picture) {
  const effective = picture?.effective?.items || {};
  const manual = picture?.manual || {};
  const derived = picture?.derived || {};
  const { armorGroups, weaponGroups, armorIndividual } = buildGroups(equipment);

  const armorBlocks = individualBlocks(armorIndividual, effective);
  for (const group of armorGroups.values()) {
    armorBlocks.push(...summarizeGroup(group, effective, manual, derived));
  }

  const weaponBlocks = [];
  for (const group of weaponGroups.values()) {
    weaponBlocks.push(...summarizeGroup(group, effective, manual, derived));
  }

  return {
    armor: finalize(armorBlocks),
    weapons: finalize(weaponBlocks),
  };
}
