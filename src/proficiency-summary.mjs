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
// In addition to the native catalog categories, the summary compactly groups
// classes' direct weapon grants into a single `kind: 'class'` row per class
// source and, for shields only, may emit a class-derived Shields category:
//
//   - Class weapon rows gather the direct item grants of a `type: 'class'`
//     source that are weapons, effective-positive and NOT already covered by a
//     positive catalog category of their weapon group. An item is covered even
//     when it is the group's positive exception, so a class row never duplicates
//     a catalog category item. Item ids are de-duplicated across class sources by
//     first source. The row header level is only set when every included item
//     carries the identical effective level; otherwise it is null.
//   - Shield categories come from a class source only when the Shields group is
//     not uniformly positive and carries no explicit positive group state, when
//     a `type: 'class'` source grants at least half of the catalog shield
//     entries directly at a positive level and at least half of the total
//     shields remain effective-positive among that source's shield ids. The
//     baseline tier is the chosen source's positive shield-grant tier, picked
//     deterministically by highest coverage then source order; every shield with
//     a differing effective level (untrained or basic included) is listed as an
//     exception. A suppressed-all manual state and an isolated shield grant
//     never produce a category. An explicit manual Shields group state that is
//     nonpositive ('untrained' or 'basic') overrides automation and suppresses
//     the class-derived category entirely, so only standalone positive item
//     rows survive.
//
// Output rows are ordered category-first: positive catalog categories first
// (alphabetical), then class rows in `picture.sources` order, then standalone
// positive individual items (alphabetical). Armor follows the same category-
// first rule. Natural weapons stay in their native catalog group baseline and
// never enter a class row.
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

// Whether an explicit manual group state is nonpositive ('untrained' or
// 'basic'). Such a state suppresses any class-derived category for that group,
// so the caller falls through to standalone positive item rows instead.
function manualGroupStateIsNonpositive(groups, key) {
  if (!hasOwn((groups || {}), key)) return false;
  const level = normalizeLevel(groups[key]);
  return level === 'untrained' || level === 'basic';
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

// Build an individual standalone item block for a single positive entry.
function itemBlock(name, level) {
  return { sortLabel: name, kind: 'item', rows: [{ kind: 'item', label: name, level }] };
}

// Build the category block for a group with a positive baseline, preserving the
// existing category/item shape: a category row followed by its positive
// exception item rows (indented) and the exceptions array on the category row.
function buildCategoryBlock(group, members, baseline) {
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
  return { sortLabel: group.label, kind: 'category', rows: [categoryRow, ...itemRows] };
}

// Build the class weapon rows from `picture.sources`, gathering the direct item
// grants of each `type: 'class'` source that are weapons, effective-positive and
// not covered by any positive catalog weapon category of their group. Item ids
// are de-duplicated across class sources by first source. Returns `{ rows,
// assigned }` where `rows` are the emitted class rows and `assigned` is the set
// of item ids claimed by those rows.
function buildClassWeaponRows(sources, equipment, effective, coveredGroups) {
  const byId = new Map();
  for (const entry of equipment) {
    if (entry && entry.id && !byId.has(entry.id)) byId.set(entry.id, entry);
  }

  const classSources = (Array.isArray(sources) ? sources : []).filter(
    (s) => s && s.type === 'class' && s.grants && s.grants.items
  );

  const rows = [];
  const assigned = new Set();
  for (const source of classSources) {
    const items = [];
    const seenInSource = new Set();
    for (const [id] of Object.entries(source.grants.items)) {
      if (seenInSource.has(id)) continue;
      seenInSource.add(id);
      if (assigned.has(id)) continue;
      const entry = byId.get(id);
      if (!entry || entry.kind !== 'weapon') continue;
      if (coveredGroups.has(entry.group)) continue;
      const level = normalizeLevel(effective[id]);
      if (!isPositive(level)) continue;
      assigned.add(id);
      items.push({ id, label: entry.name, level });
    }

    if (items.length === 0) continue;
    items.sort((a, b) => compareStrings(a.label, b.label));
    const uniform = items.every((it) => it.level === items[0].level);
    rows.push({
      kind: 'class',
      label: `${source.label || 'Class'} Weapons`,
      level: uniform ? items[0].level : null,
      items: items.map((it) => ({ label: it.label, level: it.level })),
    });
  }

  return { rows, assigned };
}

// Build a class-derived Shields category, or null when no single `type: 'class'`
// source grants at least half of the catalog shield entries directly at a
// positive level AND at least half of the total shields remain effective-
// positive among that source's shield ids. The chosen source (highest coverage,
// then source order) provides the baseline tier; every shield with a differing
// effective level is listed as an exception.
function buildClassShieldsCategory(members, sources, effective) {
  const total = members.length;
  if (total === 0) return null;
  const half = Math.ceil(total / 2);

  const classSources = (Array.isArray(sources) ? sources : []).filter(
    (s) => s && s.type === 'class' && s.grants && s.grants.items
  );

  let best = null;
  for (const source of classSources) {
    const grants = source.grants.items;
    const granted = members.filter((m) => hasOwn(grants, m.entry.id));
    const directPositive = granted.filter((m) => isPositive(grants[m.entry.id]));
    if (directPositive.length < half) continue;
    const effPositive = granted.filter((m) => isPositive(effective[m.entry.id]));
    if (effPositive.length < half) continue;
    if (!best || granted.length > best.granted.length) {
      best = { source, granted };
    }
  }
  if (!best) return null;

  let hasExpert = false;
  let hasProf = false;
  for (const member of best.granted) {
    const lvl = normalizeLevel(best.source.grants.items[member.entry.id]);
    if (lvl === 'expert') hasExpert = true;
    else if (lvl === 'proficient') hasProf = true;
  }
  const baseline = hasExpert ? 'expert' : hasProf ? 'proficient' : null;
  if (baseline === null) return null;

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

  const categoryRow = {
    kind: 'category',
    label: SHIELD_GROUP_KEY,
    level: baseline,
    exceptions,
  };
  return { sortLabel: SHIELD_GROUP_KEY, kind: 'category', rows: [categoryRow, ...itemRows] };
}

// Summarize the weapon groups. Positive catalog categories are emitted first
// (alphabetical), then class weapon rows in `picture.sources` order, then any
// remaining uncovered positive weapons with no class source as standalone
// individual items (alphabetical).
function summarizeWeaponGroups(groups, effective, manual, derived, sources, equipment) {
  const categoryBlocks = [];
  const coveredGroups = new Set();
  const uncovered = [];

  for (const group of groups.values()) {
    const members = collectMembers(group.entries, effective);
    const baseline = chooseBaseline(members, group.baselineKey, manual, derived);
    if (baseline === null) {
      for (const member of members) {
        if (isPositive(member.level)) uncovered.push(member);
      }
    } else {
      coveredGroups.add(group.label);
      categoryBlocks.push(buildCategoryBlock(group, members, baseline));
    }
  }
  categoryBlocks.sort((a, b) => compareStrings(a.sortLabel, b.sortLabel));

  const { rows: classRows, assigned } = buildClassWeaponRows(
    sources,
    equipment,
    effective,
    coveredGroups
  );

  const itemBlocks = [];
  for (const member of uncovered) {
    if (assigned.has(member.entry.id)) continue;
    itemBlocks.push(itemBlock(member.entry.name, member.level));
  }
  itemBlocks.sort((a, b) => compareStrings(a.sortLabel, b.sortLabel));

  const rows = [];
  for (const block of categoryBlocks) rows.push(...block.rows);
  for (const row of classRows) rows.push(row);
  for (const block of itemBlocks) rows.push(...block.rows);
  return rows;
}

// Summarize the armor output: positive catalog armor categories first
// (alphabetical, including a class-derived Shields category when eligible), then
// any uncovered standalone positive armor items (alphabetical). There are no
// class rows in the armor list.
function summarizeArmorGroups(armorGroups, armorIndividual, effective, manual, derived, sources) {
  const categoryBlocks = [];
  const standalone = [];

  for (const entry of armorIndividual) {
    const level = normalizeLevel(effective[entry.id]);
    if (isPositive(level)) standalone.push({ entry, level });
  }

  for (const group of armorGroups.values()) {
    const members = collectMembers(group.entries, effective);
    const baseline = chooseBaseline(members, group.baselineKey, manual, derived);
    if (baseline !== null) {
      categoryBlocks.push(buildCategoryBlock(group, members, baseline));
      continue;
    }
    if (
      group.label === SHIELD_GROUP_KEY &&
      !manualGroupStateIsNonpositive(manual.groups, SHIELD_GROUP_KEY)
    ) {
      const shieldCategory = buildClassShieldsCategory(members, sources, effective);
      if (shieldCategory) {
        categoryBlocks.push(shieldCategory);
        continue;
      }
    }
    for (const member of members) {
      if (isPositive(member.level)) standalone.push({ entry: member.entry, level: member.level });
    }
  }

  categoryBlocks.sort((a, b) => compareStrings(a.sortLabel, b.sortLabel));
  const itemBlocks = standalone
    .map((item) => itemBlock(item.entry.name, item.level))
    .sort((a, b) => compareStrings(a.sortLabel, b.sortLabel));

  const rows = [];
  for (const block of categoryBlocks) rows.push(...block.rows);
  for (const block of itemBlocks) rows.push(...block.rows);
  return rows;
}

// Summarize the effective RME armor and weapon proficiencies for an actor sheet.
//
// `equipment` is an iterable of catalog entries; `picture` is the result of
// `computeActorTraining` and must expose `effective.items` (the per-item
// effective level map), the optional `manual` / `derived` group states used to
// honor manual-overrides-automation precedence, and the optional `sources`
// array used to group class-origin weapon grants and class shield grants. No
// input is mutated and no Foundry global is touched.
export function summarizeRmeProficiencies(equipment, picture) {
  const effective = picture?.effective?.items || {};
  const manual = picture?.manual || {};
  const derived = picture?.derived || {};
  const sources = picture?.sources || [];
  const { armorGroups, weaponGroups, armorIndividual } = buildGroups(equipment);

  const armor = summarizeArmorGroups(
    armorGroups,
    armorIndividual,
    effective,
    manual,
    derived,
    sources
  );
  const weapons = summarizeWeaponGroups(
    weaponGroups,
    effective,
    manual,
    derived,
    sources,
    equipment
  );

  return { armor, weapons };
}
