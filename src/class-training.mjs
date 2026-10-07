// Class training grants derived from rules/ClassTraining.md.
//
// This module produces the base "basic training" grants a single class confers
// at character creation. It does NOT resolve any multiclass or expert-train
// interactions, and it never promotes or overrides anything - it only returns
// the grant object a caller merges into training state (see training.mjs
// grantTraining). Duplicate handling (e.g. item-level promotion on duplicate
// non-multiclass grants) is the caller's job.
//
// The catalog has no "simple"/"martial" split; per rules/Introduction.md, a
// weapon is simple if it does NOT carry the Awkward property at the Untrained
// tier (a weapon that does is martial). The source writes some untrained rows
// without whitespace after the label ("UntrainedAwkward", "UntrainedOne-Handed"),
// so property detection always strips the tier label first.

const CATEGORY_CHOICE_CLASSES = new Set(['fighter', 'barbarian', 'paladin', 'ranger']);

// Weapon groups that actually contain `kind === 'weapon'` entries. Armor,
// Shields and Natural Weapons are excluded; a class chooses from these.
const WEAPON_GROUPS = [
  'Ambush Weapons',
  'Axes',
  'Bludgeons',
  'Bows',
  'Combat Blades',
  'Crossbows',
  'Dueling Blades',
  'Firearms',
  'Flails',
  'Hammers Picks',
  'Launch Weapons',
  'Polearms',
  'Spears',
  'Throwing Weapons',
  'Whips',
];

// Group names a category-choice class cannot pick. These are the only group
// restrictions; property-based exclusions are handled per-item in classGrants.
const FORBIDDEN_GROUP_BY_CLASS = {
  barbarian: ['Firearms', 'Crossbows'],
  paladin: ['Firearms', 'Throwing Weapons'],
  ranger: ['Polearms', 'Flails'],
};

// A weapon property that is excluded from a class's chosen categories even
// when the category itself is allowed (rules/ClassTraining.md):
//   barbarian - no weapon with the Clockwork property
//   paladin   - no weapon with the Conceal property
//   ranger    - no weapon with the Clockwork property
const EXCLUDED_PROPERTY_BY_CLASS = {
  barbarian: 'Clockwork',
  paladin: 'Conceal',
  ranger: 'Clockwork',
};

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

// Armor + shield grants per class. `armor` lists the armor categories granted,
// `shields` is one of 'all' | 'no-clockwork' | 'none'.
const ARMOR_GRANT_BY_CLASS = {
  artificer: { armor: ['medium', 'light'], shields: 'all' },
  barbarian: { armor: ['medium', 'light'], shields: 'no-clockwork' },
  bard: { armor: ['light'], shields: 'none' },
  cleric: { armor: ['medium', 'light'], shields: 'no-clockwork' },
  druid: { armor: ['medium', 'light'], shields: 'all' },
  fighter: { armor: ['heavy', 'medium', 'light'], shields: 'all' },
  monk: { armor: [], shields: 'none' },
  paladin: { armor: ['heavy', 'medium', 'light'], shields: 'all' },
  ranger: { armor: ['medium', 'light'], shields: 'no-clockwork' },
  rogue: { armor: ['light'], shields: 'none' },
  sorcerer: { armor: [], shields: 'none' },
  warlock: { armor: ['light'], shields: 'none' },
  wizard: { armor: [], shields: 'none' },
};

// The 13 class identifiers, lowercase. Note the source lists "12 classes" but
// enumerates 13; the enumeration is authoritative.
export const CLASS_IDS = [
  'artificer',
  'barbarian',
  'bard',
  'cleric',
  'druid',
  'fighter',
  'monk',
  'paladin',
  'ranger',
  'rogue',
  'sorcerer',
  'warlock',
  'wizard',
];

// ---------------------------------------------------------------------------
// Property / simple helpers
// ---------------------------------------------------------------------------

function tierBody(row) {
  const match = /^(Untrained|Proficient|Basic|Expert)/.exec(row);
  return match ? row.slice(match[0].length) : row;
}

// Does a catalog entry carry a named property? Weapons and natural weapons
// declare properties in their tier rows. Armor and shields keep their property
// list only in prose (e.g. Diskarmor's Clockwork), so for those kinds we also
// scan the description.
function hasProperty(entry, property) {
  const re = new RegExp(`\\b${property}\\b`);
  if (entry.kind === 'weapon' || entry.kind === 'natural') {
    return (entry.tiers || []).some((row) => re.test(tierBody(row)));
  }
  const text =
    (entry.tiers || []).map(tierBody).join(' ') + ' ' + (entry.description || '');
  return re.test(text);
}

function untrainedRows(entry) {
  return (entry.tiers || []).filter((row) => /^Untrained/.test(row));
}

function untrainedIsAwkward(entry) {
  return untrainedRows(entry).some((row) => /\bAwkward\b/.test(tierBody(row)));
}

// "Simple" definition (rules/Introduction.md): a weapon that does not have the
// Awkward property at the Untrained tier. Natural weapons are not weapons.
function isSimpleWeapon(entry) {
  return entry.kind === 'weapon' && untrainedRows(entry).length > 0 && !untrainedIsAwkward(entry);
}

// ---------------------------------------------------------------------------
// Catalog indexing
// ---------------------------------------------------------------------------

function indexEquipment(equipment) {
  const byGroup = new Map();
  const armor = [];
  const shields = [];
  for (const entry of equipment) {
    if (!entry.group || !entry.id) continue;
    if (!byGroup.has(entry.group)) byGroup.set(entry.group, []);
    byGroup.get(entry.group).push(entry);
    if (entry.kind === 'armor') armor.push(entry);
    else if (entry.kind === 'shield') shields.push(entry);
  }
  return { byGroup, armor, shields };
}

// The set of weapon group names present in the supplied catalog. A group only
// counts as a weapon group when its entries are weapons.
function weaponGroupSet(index) {
  const set = new Set();
  for (const [group, entries] of index.byGroup) {
    if (entries.some((entry) => entry.kind === 'weapon')) set.add(group);
  }
  return set;
}

// ---------------------------------------------------------------------------
// eligibleGroups
// ---------------------------------------------------------------------------

function normalizeClass(classId) {
  const id = String(classId).toLowerCase();
  if (!CLASS_IDS.includes(id)) {
    throw new Error(`Unknown class: ${classId}`);
  }
  return id;
}

// The weapon categories a class may choose. Catalog weapon groups minus
// Armor/Shields/Natural-Weapons are eligible, further restricted by the class's
// forbidden groups (barbarian Firearms/Crossbows, paladin Firearms/Throwing
// Weapons, ranger Polearms/Flails). Property-based exclusions (Clockwork /
// Conceal) are NOT applied here - they are enforced per-item in classGrants;
// a category containing an excluded item is still selectable.
export function eligibleGroups(classId, equipment) {
  const id = normalizeClass(classId);
  const index = indexEquipment(equipment);
  const forbidden = new Set(FORBIDDEN_GROUP_BY_CLASS[id] || []);
  const groups = [...weaponGroupSet(index)];
  return groups
    .filter((group) => !forbidden.has(group))
    .sort();
}

// ---------------------------------------------------------------------------
// Category-choice validation
// ---------------------------------------------------------------------------

function validateChoices(classId, equipment, chosenGroups, seed) {
  const eligible = new Set(eligibleGroups(classId, equipment));
  const seen = new Set();
  for (const group of chosenGroups) {
    if (seen.has(group)) {
      throw new Error(`Duplicate category for ${classId}: ${group}`);
    }
    seen.add(group);
    if (!eligible.has(group)) {
      throw new Error(`Unknown or forbidden category for ${classId}: ${group}`);
    }
  }
  if (chosenGroups.length > 8) {
    throw new Error(`Too many categories for ${classId}: ${chosenGroups.length} (max 8)`);
  }
  if (seed && chosenGroups.length !== 8) {
    throw new Error(
      `Starting seed requires exactly 8 categories for ${classId}; got ${chosenGroups.length}`
    );
  }
}

// ---------------------------------------------------------------------------
// Grant builders
// ---------------------------------------------------------------------------

function addItem(grants, id) {
  if (id) grants.items[id] = 'proficient';
}

function addGroup(grants, group) {
  grants.groups[group] = 'proficient';
}

function addSimpleWeapons(grants, equipment) {
  for (const entry of equipment) {
    if (isSimpleWeapon(entry)) addItem(grants, entry.id);
  }
}

function addGroupAsItems(grants, index, group, { excludeProperty = null } = {}) {
  for (const entry of index.byGroup.get(group) || []) {
    if (excludeProperty && hasProperty(entry, excludeProperty)) continue;
    if (entry.kind === 'weapon') addItem(grants, entry.id);
  }
}

function addPropertyWeapons(grants, equipment, property) {
  for (const entry of equipment) {
    if (entry.kind === 'weapon' && hasProperty(entry, property)) {
      addItem(grants, entry.id);
    }
  }
}

function addOneHandedSimpleWeapons(grants, equipment) {
  for (const entry of equipment) {
    if (isSimpleWeapon(entry) && hasProperty(entry, 'One-Handed')) {
      addItem(grants, entry.id);
    }
  }
}

function addCategoryWeapons(grants, classId, equipment, chosenGroups) {
  const index = indexEquipment(equipment);
  const excludedProperty = EXCLUDED_PROPERTY_BY_CLASS[classId] || null;
  for (const group of chosenGroups) {
    if (excludedProperty) {
      // Per-item enumeration so an excluded item never slips in by group grant.
      addGroupAsItems(grants, index, group, { excludeProperty: excludedProperty });
    } else {
      addGroup(grants, group);
    }
  }
}

function addFixedWeaponGrants(grants, classId, equipment) {
  const index = indexEquipment(equipment);

  switch (classId) {
    case 'artificer':
      // All simple weapons, plus the Crossbows and Firearms groups, plus every
      // weapon with the Clockwork property.
      addSimpleWeapons(grants, equipment);
      addGroup(grants, 'Crossbows');
      addGroup(grants, 'Firearms');
      addPropertyWeapons(grants, equipment, 'Clockwork');
      break;

    case 'bard':
      // All simple weapons, Dueling Blades, Throwing Weapons, plus the named
      // interceptor, longsword and scimitar.
      addSimpleWeapons(grants, equipment);
      addGroup(grants, 'Dueling Blades');
      addGroup(grants, 'Throwing Weapons');
      addItem(grants, 'ambush-weapons/interceptor');
      addItem(grants, 'combat-blades/longsword');
      addItem(grants, 'combat-blades/scimitar');
      break;

    case 'cleric':
      // All simple weapons only.
      addSimpleWeapons(grants, equipment);
      break;

    case 'druid':
      // Ambush, Bludgeons, Launch, Spears and Throwing weapons without the
      // Clockwork property, plus the named dagger, kukri, scimitar, sickle,
      // tomahawk, war scythe, wall pick and whip.
      for (const group of ['Ambush Weapons', 'Bludgeons', 'Launch Weapons', 'Spears', 'Throwing Weapons']) {
        addGroupAsItems(grants, index, group, { excludeProperty: 'Clockwork' });
      }
      addItem(grants, 'dueling-blades/dagger');
      addItem(grants, 'dueling-blades/kukri');
      addItem(grants, 'combat-blades/scimitar');
      addItem(grants, 'dueling-blades/sickle');
      addItem(grants, 'axes/tomahawk');
      addItem(grants, 'polearms/war-scythe');
      addItem(grants, 'hammers-picks/wall-pick');
      addItem(grants, 'whips/whip');
      break;

    case 'rogue':
      // All simple weapons, Dueling Blades, and every weapon with the Conceal
      // property.
      addSimpleWeapons(grants, equipment);
      addGroup(grants, 'Dueling Blades');
      addPropertyWeapons(grants, equipment, 'Conceal');
      break;

    case 'warlock':
      // All simple weapons only.
      addSimpleWeapons(grants, equipment);
      break;

    case 'monk':
      // The monk weapons table is not available in the catalog, so we grant
      // every one-handed simple weapon plus the shortsword, which is what the
      // multiclass line ("Simple weapons, shortswords") implies. Any additional
      // weapons granted by the absent table (e.g. unarmed-strike) are not part
      // of this approximation.
      addOneHandedSimpleWeapons(grants, equipment);
      addItem(grants, 'dueling-blades/shortsword');
      break;

    case 'sorcerer':
    case 'wizard':
      // No weapon training.
      break;
  }
}

function armorTypeOf(entry) {
  return ARMOR_TYPE_BY_NAME[entry.name];
}

function addArmorGrants(grants, classId, equipment) {
  const config = ARMOR_GRANT_BY_CLASS[classId];
  if (!config) return;
  const index = indexEquipment(equipment);
  const allowed = new Set(config.armor);

  for (const entry of index.armor) {
    const type = armorTypeOf(entry);
    if (type && allowed.has(type)) addItem(grants, entry.id);
  }

  if (config.shields === 'all') {
    for (const entry of index.shields) addItem(grants, entry.id);
  } else if (config.shields === 'no-clockwork') {
    for (const entry of index.shields) {
      if (!hasProperty(entry, 'Clockwork')) addItem(grants, entry.id);
    }
  }
}

// ---------------------------------------------------------------------------
// classGrants
// ---------------------------------------------------------------------------

// Build the base basic-training grants for a single class.
//
//   - `classId` is lower-case (`CLASS_IDS` member); an unknown class throws.
//   - `chosenGroups` is only used by fighter/barbarian/paladin/ranger; for the
//     other classes it must be omitted (default []).
//   - `options.seed` (default false): when true the category-choice classes
//     must name exactly 8 categories; fewer or more throws. When false, up to 8
//     categories are accepted (a partially-built character is allowed).
//
// Returns `{ groups, items }` of 'proficient' grants. It never mutates inputs.
export function classGrants(classId, equipment, chosenGroups = [], options = {}) {
  const id = normalizeClass(classId);
  const seed = Boolean(options.seed);

  const grants = { groups: {}, items: {} };

  if (CATEGORY_CHOICE_CLASSES.has(id)) {
    validateChoices(id, equipment, chosenGroups, seed);
    addCategoryWeapons(grants, id, equipment, chosenGroups);
  } else {
    addFixedWeaponGrants(grants, id, equipment);
  }

  addArmorGrants(grants, id, equipment);

  return grants;
}
