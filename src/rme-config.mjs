// Register RME weapon categories and weapon properties as dnd5e Item Details
// choices (the weapon type dropdown and the weapon property checkbox list) by
// mutating a CONFIG.DND5E-like object.
//
// This module has no Foundry globals, no Hooks, and no I/O: it is a pure
// function over the config object it is handed, so the main entry point can
// call it during `init` without introducing ordering problems. It never
// overwrites an existing entry, so re-running it is a no-op and native dnd5e
// entries are left exactly as they were.
//
// Scope:
//   - config.weaponTypes[...]         : each RME weapon group as a display label.
//   - config.weaponTypeMap[key]       : a melee / ranged mode hint (`melee` /
//     `ranged`), never the simple / martial proficiency category.
//   - config.itemProperties[key]      : each RME weapon property as RME: <Name>.
//   - config.validProperties.weapon   : the RME property keys, so the sheet
//     surfaces them as valid weapon-property checkboxes.

import {
  RME_WEAPON_GROUPS,
  RME_PROPERTY_NAMES,
  rmeWeaponType,
} from './rme-metadata.mjs';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// A plain object / record (not null, not an array).
function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

// A Set, or anything with an `add` function (the test doubles and a real Set).
function isSetLike(value) {
  return value instanceof Set || (isRecord(value) && typeof value.add === 'function');
}

// The kebab-case slug used to build a stable RME property key. This is the exact
// algorithm used by the catalog metadata (rme-metadata.mjs), so the keys
// produced here are identical to the `rme-*` keys that `tierProperties` emits.
function kebab(text) {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

// The display title of an RME property. The source headings carry a ` (#)`
// parameter placeholder on Firearm, Loading, and Unwieldy that is not part of
// the property name; RME_PROPERTY_NAMES already exposes the base titles, so
// this replacement is a no-op today but is kept defensively so a ` (#)` suffix
// never reaches a sheet label - consistent with the tier-property labels used
// elsewhere in the module.
function propertyBaseName(name) {
  return name.replace(/\s*\(#\)$/, '');
}

// Deliverable display label for a weapon group. The only group that is not
// rendered verbatim is "Hammers Picks", which reads "Hammers and Picks".
function weaponTypeLabel(group) {
  return `RME: ${group === 'Hammers Picks' ? 'Hammers and Picks' : group}`;
}

// Require a core config object, throwing a helpful error rather than silently
// registering nowhere (which would leave a confusing blank dropdown).
function requireRecord(config, key) {
  const value = config[key];
  if (!isRecord(value)) {
    const got = value === null ? 'null' : Array.isArray(value) ? 'an array' : typeof value;
    throw new Error(
      `registerRmeConfig: expected the CONFIG.DND5E-like config to carry a "${key}" object, but got ${got}.`
    );
  }
  return value;
}

// ---------------------------------------------------------------------------
// registerRmeConfig
// ---------------------------------------------------------------------------

/**
 * Register RME weapon categories and weapon properties into a CONFIG.DND5E-like
 * object. The function is idempotent and never clobbers an existing entry, so
 * native dnd5e weapon types / properties are preserved. It throws a helpful
 * error only when a required core config object is missing.
 *
 * @param {object} config A CONFIG.DND5E-like object with `weaponTypes`,
 *   `weaponTypeMap`, `itemProperties`, and `validProperties.weapon`.
 * @returns {void}
 */
export function registerRmeConfig(config) {
  if (!isRecord(config)) {
    throw new Error(
      'registerRmeConfig: expected a CONFIG.DND5E-like config object to register into.'
    );
  }

  const weaponTypes = requireRecord(config, 'weaponTypes');
  const weaponTypeMap = requireRecord(config, 'weaponTypeMap');
  const itemProperties = requireRecord(config, 'itemProperties');
  const validProperties = requireRecord(config, 'validProperties');

  if (!isSetLike(validProperties.weapon)) {
    throw new Error(
      'registerRmeConfig: expected config.validProperties.weapon to be a Set of valid weapon-property keys.'
    );
  }

  // --- Weapon categories -----------------------------------------------------
  // Register each of the 15 RME weapon groups as a selectable weapon type. The
  // melee/ranged mode hint is stored in weaponTypeMap (dnd5e's "attack type"
  // mapping), and no simple/martial proficiency is claimed, so `weaponProficiencies`
  // is left alone.
  for (const group of RME_WEAPON_GROUPS) {
    const type = rmeWeaponType(group);
    if (!type || type.mode === 'natural') continue;
    if (!Object.hasOwn(weaponTypes, type.key)) {
      weaponTypes[type.key] = weaponTypeLabel(group);
    }
    if (!Object.hasOwn(weaponTypeMap, type.key)) {
      weaponTypeMap[type.key] = type.mode;
    }
  }

  // --- Weapon properties -----------------------------------------------------
  // Register every RME weapon property under a stable `rme-<kebab>` key and
  // expose it as a valid weapon property. The native key space (e.g. `fir`, and
  // the native `amm` ammunition key) is never touched because RME keys are
  // namespaced with the `rme-` prefix, so RME's Ammunition property does not
  // trigger dnd5e's native ammo consumption or double spending.
  for (const name of RME_PROPERTY_NAMES) {
    const baseName = propertyBaseName(name);
    const key = `rme-${kebab(baseName)}`;
    if (!Object.hasOwn(itemProperties, key)) {
      itemProperties[key] = { label: `RME: ${baseName}` };
    }
    validProperties.weapon.add(key);
  }
}
