// Pure RME item metadata extraction.
//
// This module has no Foundry globals and no filesystem access, so it is safe
// to load in the Foundry runtime (browser-like) as well as under Node for
// tests. It only reads data passed to it, and never mutates its inputs.
//
// The catalog carries no structured weight/price fields, so physical stats are
// parsed faithfully from the source text (the italic stat line for weapons and
// shields, the table row at the start of an armor description). Properties are
// extracted from the tier rows selected by the shared training model.
//
// Source reference: rules/WeaponProperties.md lists 42 weapon-property
// headings (not 40). The source headings keep the ` (#)` parameter placeholder
// on Firearm/Loading/Unwieldy, but RME_PROPERTY_NAMES exports the base display
// titles (Firearm, Loading, Unwieldy) so property titles never expose the
// placeholder. Ammunition is an extra RME property with no source heading.

import { LEVELS, selectTier } from './training.mjs';

// ---------------------------------------------------------------------------
// Property names
// ---------------------------------------------------------------------------

// Every `##### ` heading in rules/WeaponProperties.md, verbatim and in source
// order, minus the ` (#)` parameter placeholder that the source carries on
// Firearm, Loading, and Unwieldy. Property titles expose the base name so the
// placeholder never appears on a sheet label. Ammunition is an extra RME
// property that is not a source heading; it is registered for ammo-launching
// ranged weapons.
export const RME_PROPERTY_NAMES = [
  'Affixed',
  'Awkward',
  'Barbed',
  'Balanced',
  'Brace',
  'Clockwork',
  'Conceal',
  'Deflect',
  'Disarm',
  'Double Ended',
  'Entangle',
  'Finesse',
  'Firearm',
  'Heavy',
  'Hipshot',
  'Keen',
  'Knockback',
  'Light',
  'Loading',
  'Lunge',
  'Melee',
  'Natural',
  'Nimble',
  'One-Handed',
  'Penetrate',
  'Punch',
  'Puncture',
  'Ranged',
  'Reach',
  'Reload',
  'Riposte',
  'Sighted',
  'Slip',
  'Stagger',
  'Steady',
  'Sunder',
  'Thrown',
  'Trip',
  'Two-Handed',
  'Unwieldy',
  'Versatile',
  'Wound',
  'Ammunition',
];

// Property identity: the ` (#)` placeholder marks a numeric parameter, not part
// of the property name. This is the set used for catalog-token matching and
// for `tierProperties` labels. RME_PROPERTY_NAMES already carries the base
// titles, so the replacement is a no-op today but is kept defensively so a
// ` (#)` suffix on a future source heading never leaks into a tier label.
const PROPERTY_BASE_NAMES = RME_PROPERTY_NAMES.map((name) =>
  name.replace(/\s*\(#\)$/, '')
);

function escapeRegexChar(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Match a property name case-insensitively with word boundaries. Hyphens and
// spaces in the source name are treated as interchangeable separators so that
// source typos (e.g. "Two handed" for Two-Handed) still match.
function propertyNamePattern(name) {
  const parts = name.split(/[\s-]+/).map(escapeRegexChar);
  const joined = parts.join('[ \\-]+');
  return new RegExp(`(?<![A-Za-z])${joined}(?![A-Za-z])`, 'gi');
}

const PROPERTY_PATTERNS = PROPERTY_BASE_NAMES.map((name) => ({
  name,
  re: propertyNamePattern(name),
}));

// Recognized misspellings / truncations that appear in the source tier rows.
const PROPERTY_ALIASES = [
  // spears/winged-spear writes "Punc" for Puncture.
  { name: 'Puncture', re: /(?<![A-Za-z])punc(?![A-Za-z])/gi },
];

function collectPropertyMatches(text) {
  const matches = [];
  for (const { name, re } of PROPERTY_PATTERNS) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(text)) !== null) {
      matches.push({ name, start: m.index, end: m.index + m[0].length });
    }
  }
  for (const { name, re } of PROPERTY_ALIASES) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(text)) !== null) {
      matches.push({ name, start: m.index, end: m.index + m[0].length });
    }
  }
  matches.sort((a, b) => a.start - b.start || a.end - b.end);
  // Drop overlapping matches (e.g. a longer name that begins where a shorter
  // one did), keeping the leftmost-longest-consistent first occurrence.
  const out = [];
  let lastEnd = -1;
  for (const match of matches) {
    if (match.start >= lastEnd) {
      out.push(match);
      lastEnd = match.end;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Physical stats
// ---------------------------------------------------------------------------

const WEIGHT_RE = /(\d+(?:\.\d+)?)\s*(lbs|lb|pounds|pound)\b/i;
// The trailing `g` alternative is a source typo for "gp" (Portable Catapult:
// "_Bludgeoning, 20lb, 175g_"). It is interpreted as gp with a comment below.
const PRICE_RE = /(\d+(?:\.\d+)?)\s*(gp|sp|cp|g)\b/i;
const ARMOR_ROW_RE = /^(.+?)\s+(\d+)\s+(None|Disadvantage|Normal)\s+(\d+)\s+(\d+)\s*$/m;
const STAT_LINE_RE = /^_([^_]+)_/m;

// Parse the physical stats of a catalog entry. Returns an object with any of
// the shape `{ weight: { value, units: 'lb' }, price: { value, denomination } }`.
// A missing or malformed value is omitted rather than silently coerced to 0.
//
// Weapons and shields carry their stats in the italic stat line (e.g.
// "_Piercing, 12 lbs, 1000 gp_"). Armor carries them in the verbatim table row
// that leads its description (`<Name> <AC> <Stealth> <Weight> <Gold Cost>`),
// where every cost is in gp. Natural weapons have no weight or price, so both
// keys are omitted.
export function parsePhysical(entry) {
  const result = {};
  const desc = String(entry.description || '');

  if (entry.kind === 'armor') {
    const m = ARMOR_ROW_RE.exec(desc);
    if (m) {
      result.weight = { value: Number(m[4]), units: 'lb' };
      result.price = { value: Number(m[5]), denomination: 'gp' };
    }
    return result;
  }

  const stats = STAT_LINE_RE.exec(desc);
  if (!stats) return result;

  const priceLine = stats[1];
  const wm = WEIGHT_RE.exec(priceLine);
  if (wm) {
    result.weight = { value: Number(wm[1]), units: 'lb' };
  }
  const pm = PRICE_RE.exec(priceLine);
  if (pm) {
    let denomination = pm[2].toLowerCase();
    if (denomination === 'g') {
      // Source typo: "175g" means "175 gp" (Portable Catapult).
      denomination = 'gp';
    }
    result.price = { value: Number(pm[1]), denomination };
  }
  return result;
}

// List every non-natural catalog entry that is missing a required physical
// stat. Natural weapons are excluded (they genuinely have no weight or price).
// Each issue is `{ id, name, missing }` where `missing` names the stat(s).
export function physicalParseIssues(equipment) {
  const issues = [];
  for (const entry of equipment) {
    if (entry.kind === 'natural') continue;
    const parsed = parsePhysical(entry);
    const missing = [];
    if (!parsed.weight) missing.push('weight');
    if (!parsed.price) missing.push('price');
    if (missing.length > 0) {
      issues.push({ id: entry.id, name: entry.name, missing });
    }
  }
  return issues;
}

// ---------------------------------------------------------------------------
// Weapon groups
// ---------------------------------------------------------------------------

// The 15 canonical RME weapon groups from the catalog, excluding Shields and
// Natural Weapons (and the Armor group, which is not a weapon group).
export const RME_WEAPON_GROUPS = [
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

const RANGED_GROUPS = new Set([
  'Firearms',
  'Bows',
  'Crossbows',
  'Launch Weapons',
  'Throwing Weapons',
]);

// Map a weapon group to a stable config: `{ key, mode }`. The 15 weapon groups
// yield `key = 'rme' + <GroupName>` and a melee/ranged mode hint (Firearms,
// Bows, Crossbows, Launch Weapons, and Throwing Weapons are ranged; the rest
// are melee). Natural weapons stay as the native `natural` config. Any other
// group (including Shields and Armor) returns null.
export function rmeWeaponType(group) {
  if (group === 'Natural Weapons') {
    return { key: 'natural', mode: 'natural' };
  }
  if (!RME_WEAPON_GROUPS.includes(group)) return null;
  return {
    key: 'rme' + group.replace(/\s+/g, ''),
    mode: RANGED_GROUPS.has(group) ? 'ranged' : 'melee',
  };
}

// ---------------------------------------------------------------------------
// Ammunition
// ---------------------------------------------------------------------------

// Ranged groups whose weapons launch and consume a projectile: bows launch
// arrows, crossbows launch bolts (including Spinner and Portable Ballista), and
// firearms launch cartridges. Every weapon in these groups consumes ammo.
const AMMO_RANGED_GROUPS = new Set(['Bows', 'Crossbows', 'Firearms']);

// Whether a catalog entry is a weapon that launches and consumes ammunition.
// Group membership excludes shields, armor, natural weapons, and melee groups:
// none of them belong to Bows/Crossbows/Firearms. Launch Weapons (Atlatl,
// Blowgun, Sling, Sling Staff, Sling Tube, Portable Catapult, Rope Dart, etc.)
// are ranged but are not tracked here until compatible ammo items are
// specified, so none of them carry Ammunition.
function isAmmoLaunchingWeapon(entry) {
  return AMMO_RANGED_GROUPS.has(entry.group);
}

// ---------------------------------------------------------------------------
// Tier property extraction
// ---------------------------------------------------------------------------

const TIER_LABEL_RE = /^(Untrained|Proficient|Basic|Expert)\s*/;

function stripTierLabel(row) {
  return row.replace(TIER_LABEL_RE, '');
}

function kebabKey(label) {
  const slug = label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return `rme-${slug}`;
}

function cleanRaw(raw) {
  let text = raw.trim();
  // Drop a trailing comma/period, then any trailing connective (e.g. the "and"
  // preceding an embedded property in prose) so a raw token does not leak.
  text = text.replace(/[,.]+$/, '').trim();
  text = text.replace(/\s+(?:and|or|but)\s*$/i, '').trim();
  return text;
}

// Balanced-parenthesis content of the first parenthesized group. Returns the
// inner text (the param), which may itself contain nested parentheses (e.g.
// Reload (Object Interaction (single cartridge)) -> Object Interaction (single
// cartridge)). Returns undefined when there is no parenthesized group.
function extractParameter(text) {
  const start = text.indexOf('(');
  if (start === -1) return undefined;
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
  return undefined;
}

function dedupeByLabel(props) {
  const seen = new Set();
  const out = [];
  for (const prop of props) {
    const key = prop.label.toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      out.push(prop);
    }
  }
  return out;
}

// Extract the known RME properties from a single tier row. The output is an
// exhaustive list of `{ key, label, raw, parameter? }` entries where `label` is
// the canonical property name, `raw` is the verbatim source token (including
// any parameters), and `parameter` (when present) is the balanced parenthesized
// content. Comma-separated property lists are split, but the parser also
// tolerates a missing comma between adjacent properties (e.g. "Double Ended
// (one dice size smaller) Knockback" and "Disarm Firearm (1)") and prose that
// merely mentions a property name (e.g. shield tier rows). Unknown tokens that
// are not RME properties (bare dice, bare ranges, damage types) are skipped.
function extractPropertiesFromRow(row) {
  const body = stripTierLabel(row);
  const segments = body.split(',');
  const props = [];

  for (const segment of segments) {
    const matches = collectPropertyMatches(segment);
    for (let i = 0; i < matches.length; i++) {
      const match = matches[i];
      const end = i + 1 < matches.length ? matches[i + 1].start : segment.length;
      const raw = cleanRaw(segment.slice(match.start, end));
      const parameter = extractParameter(raw);
      props.push({
        key: kebabKey(match.name),
        label: match.name,
        raw,
        ...(parameter !== undefined ? { parameter } : {}),
      });
    }
  }

  return dedupeByLabel(props);
}

// A shield or armor tier row is a property declaration only when its body
// (after the tier label) begins with a known RME property, exactly like a
// weapon row ("Untrained Awkward, Two-Handed, ..."). Prose rows - "You gain an
// additional +2AC bonus against ranged weapon attacks" or "The buckler has
// Finesse and Deflect (d8)" - merely mention property names and do not declare
// them, so they are skipped. No current shield or armor row begins with a
// property declaration, so shields and armor yield [] until such a row appears.
function beginsWithPropertyDeclaration(row) {
  const body = stripTierLabel(row).trim();
  if (body.length === 0) return false;
  for (const { re } of PROPERTY_PATTERNS) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(body)) !== null) {
      if (m.index === 0) return true;
    }
  }
  return false;
}

// Map an input level to the levels understood by the training model. "basic"
// is accepted as an alias for "proficient" because the source labels the second
// tier "Basic" in some groups and "Proficient" in others; they are equivalent.
function normalizeLevel(level) {
  if (level === 'basic') return 'proficient';
  return LEVELS.includes(level) ? level : 'untrained';
}

// Return the known RME properties granted by an equipment entry at a training
// level. It selects the relevant tier rows through the shared `selectTier`
// model and only ever includes properties with a known name, so Expert Perk
// prose (which `selectTier` keeps separate) is never mistaken for a property.
// For weapons and natural weapons the parsed tier properties are returned as
// before. For shields and armor, tier rows are prose rather than weapon
// property grants, so only rows that begin with an explicit (weapon-style)
// comma-separated property declaration contribute properties; with no such row
// in the catalog, shields and armor always return []. The keys are guaranteed
// stable (`rme-<kebab>`) and unique within the result. Ammo-launching ranged
// weapons additionally get the tier-independent RME Ammunition property.
export function tierProperties(entry, level) {
  const safeLevel = normalizeLevel(level);
  const tier = selectTier(entry, { items: { [entry.id]: safeLevel } });

  const props = [];
  for (const row of tier.rawRows) {
    if (entry.kind === 'shield' || entry.kind === 'armor') {
      // Shield/armor rows are prose. Only rows that lead with an explicit
      // property declaration (the weapon row shape) grant anything.
      if (!beginsWithPropertyDeclaration(row)) continue;
    }
    props.push(...extractPropertiesFromRow(row));
  }
  const result = dedupeByLabel(props);

  // Ammunition is a tier-independent RME checkbox, not a tier grant, so it is
  // appended to every ammo-launching weapon at every level. It never
  // duplicates a tier row (no tier row declares Ammunition) but is guarded
  // defensively in case a source row ever starts declaring it.
  if (
    isAmmoLaunchingWeapon(entry) &&
    !result.some((p) => p.label === 'Ammunition')
  ) {
    result.push({ key: 'rme-ammunition', label: 'Ammunition', raw: 'Ammunition' });
  }
  return result;
}
