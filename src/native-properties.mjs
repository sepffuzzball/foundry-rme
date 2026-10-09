// Native dnd5e 6.x weapon-property mapping for RME.
//
// This module is pure: it has no Foundry globals and no filesystem access, so it
// is safe to load in the Foundry runtime as well as under Node for tests. It
// maps a conservative subset of shared RME weapon properties onto their native
// dnd5e 6.x keys, and reports the parsed Versatile damage dice when a weapon is
// genuinely versatile.
//
// Only properties that have a semantically identical native counterpart are ever
// promoted into the native property space:
//   - Two-Handed -> 'two'
//   - Finesse    -> 'fin'
//   - Reach      -> 'rch'   (melee weapons only)
//   - Versatile  -> 'ver'   (only when unambiguous: exactly one selected tier
//                            row, exactly one Versatile property carrying an
//                            explicit die token, and exactly one attack damage
//                            profile in the selected rows)
//
// Everything else stays in the `rme-*` namespace and is never mapped to a native
// key:
//   - Heavy, Light -> the user keeps the RME-sourced value out of a native key.
//   - Loading, Reload, Firearm -> not promoted (no faithful native counterpart
//     that the module owns).
//   - Ammunition -> deliberately excluded: the module tracks ammo through flags,
//     so a native `amm` key would double-spend.
//   - Thrown -> excluded because RME quantity semantics differ from the native
//     `thr` key.
//   - Ranged -> excluded; the native range fields are handled separately.
//
// No native key is ever invented: a weapon is only ever reported as versatile
// when the source states an explicit die; otherwise `versatile` is null.

import { LEVELS, selectTier } from './training.mjs';
import { tierProperties, rmeWeaponType } from './rme-metadata.mjs';

// Map an input level to the levels understood by the training model. "basic" is
// accepted as an alias for "proficient" because the catalogs label the second
// tier "Basic" in some groups and "Proficient" in others; they are equivalent.
// Any other unknown level falls back to untrained.
function normalizeLevel(level) {
  if (level === 'basic') return 'proficient';
  return LEVELS.includes(level) ? level : 'untrained';
}

// The shared attack damage profile token. A profile is a single `Melee NdX` /
// `Ranged NdX(+N)` expression, optionally followed by a `(normal/long)` range.
// This mirrors the conservative parser used elsewhere in the module, so a tier
// chosen for Versatile mapping counts the same attack profiles the module's
// damage mapper would see. Only an attack profile, not a Versatile/Thrown die,
// is counted: those are not preceded by Melee/Ranged.
function damageTokenRegex() {
  return /\b(Melee|Ranged)\s+(\d*d\d+(?:\+\d+)?)(?:\s+\((\d+)\/(\d+)\))?/g;
}

function countDamageTokens(rawRows) {
  let count = 0;
  for (const row of rawRows) {
    const re = damageTokenRegex();
    let m;
    while ((m = re.exec(row)) !== null) {
      count += 1;
    }
  }
  return count;
}

// Parse the Versatile die from a tier property. The die must be explicit in the
// source, never inferred. Three shapes are recognized:
//   - bare:      "Versatile d10"        -> { number: 1, denomination: 10 }
//   - multi:     "Versatile 2d4"        -> { number: 2, denomination: 4 }
//   - parenthesized: "Versatile (1d10)" -> { number: 1, denomination: 10 }
// A bare `dX` is shorthand for `1dX`; the number defaults to 1 and the
// denomination is the integer after the `d`. Returns null when the raw token
// carries no explicit die, so no die is ever invented for a Die-less Versatile.
function parseVersatileDie(prop) {
  if (!prop) return null;

  // The balanced parenthesized parameter, when present, is the die (e.g.
  // "Versatile (1d10)" extracts parameter "1d10"). It is authoritative when it
  // is a standalone die expression.
  const param = prop.parameter;
  if (typeof param === 'string' && param.trim().length > 0) {
    const m = /^(\d*)d(\d+)$/i.exec(param.trim());
    if (m) {
      return { number: m[1] === '' ? 1 : Number(m[1]), denomination: Number(m[2]) };
    }
  }

  // Otherwise search the verbatim raw token for an explicit die expression. The
  // raw token is the source text beginning at "Versatile" (e.g. "Versatile d10"
  // or "Versatile 2d4"), so the first `NdX` found is the stated versatile die.
  const raw = String(prop.raw || '');
  const m = /\b(\d*)d(\d+)\b/i.exec(raw);
  if (!m) return null;
  return { number: m[1] === '' ? 1 : Number(m[1]), denomination: Number(m[2]) };
}

// Map the shared RME weapon properties of a catalog entry at a training level to
// native dnd5e 6.x keys. Returns `{ keys, versatile }` where `keys` is the array
// of native property keys granted at that level and `versatile` is the parsed
// `{ number, denomination }` Versatile die, or null when the weapon is not
// reported versatile.
//
// The mapping is conservative and only ever promotes properties that have a
// faithful native counterpart:
//   - Two-Handed -> 'two' (always)
//   - Finesse    -> 'fin' (always)
//   - Reach      -> 'rch' (melee weapons only)
//   - Versatile  -> 'ver' (only when unambiguous: exactly one selected tier row,
//                          exactly one Versatile property, an explicit die token,
//                          and exactly one attack damage profile in the selected
//                          tier rows -- so a multi-form weapon such as the Whip
//                          Sword never reports an invented versatile die).
//
// A row that is inconsistent about the grip (listing both Two-Handed and
// Versatile at once) is resolved in favour of the explicit Two-Handed, so the
// native pair `two`/`ver` is never emitted together.
export function nativeProfile(entry, level) {
  const safeLevel = normalizeLevel(level);
  const props = tierProperties(entry, safeLevel);
  const tier = selectTier(entry, { items: { [entry.id]: safeLevel } });
  const rme = rmeWeaponType(entry?.group);
  const melee = rme?.mode === 'melee';

  const has = (label) => props.some((p) => p.label === label);

  const keys = [];
  if (has('Two-Handed')) keys.push('two');
  if (has('Finesse')) keys.push('fin');
  if (has('Reach') && melee) keys.push('rch');

  let versatile = null;
  const versatileProps = props.filter((p) => p.label === 'Versatile');
  if (versatileProps.length === 1) {
    const die = parseVersatileDie(versatileProps[0]);
    if (die && tier.rawRows.length === 1 && countDamageTokens(tier.rawRows) === 1) {
      keys.push('ver');
      versatile = die;
    }
  }

  // A weapon cannot be both two-handed and versatile in the native system. When
  // the source lists both (inconsistent), prefer the explicit Two-Handed and
  // drop the Versatile mapping rather than emitting a contradictory pair.
  if (keys.includes('two') && keys.includes('ver')) {
    keys.splice(keys.indexOf('ver'), 1);
    versatile = null;
  }

  return { keys, versatile };
}
