// Find actor-owned embedded RME Items that were synced under the old implicit
// Proficient fallback for natural weapons and must now fall back to Untrained.
//
// Historically the module mirrored `rules/NaturalWeapons.md`, which states a
// creature with a Natural weapon always has Proficient training with it (except
// Unarmed Strike). That left an actor's natural-weapons Item at
// `flags.foundry-rme.activeTier === 'proficient'` and `system.proficient === 1`
// even when no grant or manual override actually applied. The module now
// deliberately deviates (see training.mjs): natural weapons carry no implicit
// level and resolve to Untrained unless an explicit manual or derived grant
// raises them, so those legacy Items must be corrected to the Untrained
// fallback.
//
// This module is deliberate about scope. It detects that a legacy natural Item
// is now inconsistent with the actor's effective training and - through the
// existing per-actor sync queue in main.mjs - corrects ONLY the actor-owned
// embedded Item. It never rewrites world/compendium Items, never runs at
// startup, and never rejects an explicit manual/derived Proficient or Expert
// grant: those are exactly the cases the effective-training check excludes.
//
// All exported functions are pure: they read actor flags/items and the catalog,
// compute the actor's effective training, and return a boolean or a set of item
// ids without mutating any input or writing to any native trait field.

import { FLAGS_KEY } from './items.mjs';
import { computeActorTraining } from './actor-training.mjs';

const NATURAL_PREFIX = 'natural-weapons/';

// Cheap pre-fetch scan: does `actor` carry any embedded Item that could be a
// legacy natural-weapons Item synced under the old implicit Proficient
// fallback? It inspects only module-owned flags and the native proficient field
// on the actor's existing Items, so it never requires (or costs) a catalog
// fetch. A true result is only a candidate - it does not confirm that the
// catalog id is actually a natural entry, or that no grant/override applies;
// that confirmation needs the catalog and a training computation.
export function hasLegacyNaturalCandidate(actor) {
  if (!actor) return false;
  for (const item of actor.items || []) {
    const flags = item.flags?.[FLAGS_KEY];
    if (!flags) continue;
    const catalogId = flags.catalogId;
    if (typeof catalogId !== 'string' || !catalogId.startsWith(NATURAL_PREFIX)) continue;
    if (flags.activeTier !== 'proficient') continue;
    if (item.system?.proficient !== 1) continue;
    return true;
  }
  return false;
}

// The embedded-item id, whether a live Foundry embedded document exposes it as
// `id` or a serialized/mock item only carries `_id`. Used only to key the set of
// eligible items so a later itemFilter can match the exact item instance.
function embeddedItemId(item) {
  return item.id ?? item._id;
}

// Compute the set of actor-owned embedded Item ids that are legacy natural
// catalog Items which must now fall back to Untrained. All of the following must
// hold for a candidate actor Item:
//   - its `flags['foundry-rme'].catalogId` matches an actual natural catalog
//     entry (`entry.kind === 'natural'`), so an untagged, non-natural, or
//     unknown id is never targeted;
//   - `flags['foundry-rme'].activeTier === 'proficient'` (the old implicit
//     fallback tier), matching the module-owned tier marker before any edit;
//   - `item.system.proficient === 1`, so a user-changed native proficiency (0)
//     is never re-flagged;
//   - the actor's current composed effective training for that id is
//     `'untrained'`, which is the decisive test: an explicit manual override or
//     a derived Proficient/Expert grant keeps the Item from being rewritten, and
//     an ordinary natural weapon with no grant remains Untrained.
//
// `picture` is the actor's computed training picture and is recomputed (via
// computeActorTraining) when omitted, so a caller that already fetched the
// catalog and computed the picture can pass it in and avoid a second compute.
// Never mutates any input and never writes to native trait proficiency.
export function legacyNaturalItemIds(actor, equipment, picture) {
  if (!actor || !equipment) return new Set();
  const byId = new Map();
  for (const entry of equipment || []) {
    if (entry && entry.id) byId.set(entry.id, entry);
  }
  const effective = (picture ?? computeActorTraining(actor, equipment))?.effective?.items || {};

  const ids = new Set();
  for (const item of actor.items || []) {
    const flags = item.flags?.[FLAGS_KEY];
    if (!flags) continue;
    const catalogId = flags.catalogId;
    const entry = byId.get(catalogId);
    if (!entry || entry.kind !== 'natural') continue;
    if (flags.activeTier !== 'proficient') continue;
    if (item.system?.proficient !== 1) continue;
    if (effective[catalogId] !== 'untrained') continue;
    // Ignore an item that exposes neither an `id` nor an `_id`: it cannot be
    // keyed safely, and a Set of `undefined` would match any malformed no-id
    // candidate. Foundry embedded documents always carry an id, so this only
    // guards against malformed or mock items.
    const itemId = embeddedItemId(item);
    if (!itemId) continue;
    ids.add(itemId);
  }
  return ids;
}

// Whether `actor` carries any embedded Item that is a legacy natural-weapons
// catalog Item which must now fall back to Untrained. This is exactly
// `legacyNaturalItemIds(...).size > 0`: the decisive checks (actual natural
// catalog kind, module-owned activeTier proficient, native proficient 1, and an
// effective Untrained level) are all applied by the id computation.
export function hasLegacyNaturalDefault(actor, equipment) {
  if (!actor) return false;
  return legacyNaturalItemIds(actor, equipment).size > 0;
}
