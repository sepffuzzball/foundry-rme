// Pure composition service for RME training between a manually-entered
// training state and an automatically derived one.
//
// The manual state is the actor's own `training` flag (what the user explicitly
// chose in the training UI). The derived state is the suggestion produced by
// `deriveActorTraining` from the actor's embedded class/race/subclass/feat
// Items. This module composes them into a single effective per-item level and
// can push that effective state onto the actor's embedded catalog Items.
//
// Resolution precedence (highest to lowest), matching RME's manual-overrides-
// automation rule:
//   1. manual.items[entry.id]        (wins even when explicitly 'untrained')
//   2. manual.groups[entry.group]    (wins even when explicitly 'untrained')
//   3. derived.items[entry.id]
//   4. derived.groups[entry.group]
//   5. natural default (resolveTraining(entry, {}))
//
// This module has no Foundry globals, never mutates any input, and never writes
// to native trait proficiencies (`system.traits`) - it only drives the
// module-owned item profile sync in items.mjs.

import { resolveTraining } from './training.mjs';
import { deriveActorTraining } from './derive-training.mjs';
import { syncActorItems, FLAGS_KEY } from './items.mjs';

const TRAINING_KEY = 'training';
const CHOICES_KEY = 'choices';

function hasOwn(record, key) {
  return Object.prototype.hasOwnProperty.call(record, key);
}

function levelOrUntrained(value) {
  return value === 'proficient' || value === 'expert' ? value : 'untrained';
}

// Compose a single equipment entry's effective training level from the manual
// and derived states, using the precedence documented above. A present-but-
// invalid value in any higher tier resolves to 'untrained' (matching the
// training model's levelOrUntrained semantics), so an explicit manual
// 'untrained' always wins over a lower tier.
export function resolveEffectiveTraining(entry, manual = {}, derived = {}) {
  const mItems = manual.items || {};
  const mGroups = manual.groups || {};
  const dItems = derived.items || {};
  const dGroups = derived.groups || {};

  if (hasOwn(mItems, entry.id)) {
    return levelOrUntrained(mItems[entry.id]);
  }
  if (hasOwn(mGroups, entry.group)) {
    return levelOrUntrained(mGroups[entry.group]);
  }
  if (hasOwn(dItems, entry.id)) {
    return levelOrUntrained(dItems[entry.id]);
  }
  if (hasOwn(dGroups, entry.group)) {
    return levelOrUntrained(dGroups[entry.group]);
  }
  return resolveTraining(entry, {});
}

// Compute the fully-resolved per-item effective level map for every entry in
// `equipment`. Returns `{ items: { [entry.id]: level } }` so the result is a
// drop-in training state for syncActorItems/resolveTraining.
export function effectiveItemLevels(equipment, manual = {}, derived = {}) {
  const items = {};
  for (const entry of equipment) {
    if (!entry.id) continue;
    items[entry.id] = resolveEffectiveTraining(entry, manual, derived);
  }
  return { items };
}

// Compute the full actor training picture for an actor:
//   - `manual`: the actor's stored manual training state (`training` flag)
//   - `choices`: the actor's stored automation choices (`choices` flag)
//   - `derived`: the suggested training derived from the actor's Items
//   - `gaps` / `sources`: derivation diagnostics (derivation gaps / providers)
//   - `effective`: the composed per-item level map
//
// No input is mutated and no native trait field is touched.
export function computeActorTraining(actor, equipment) {
  const manual = actor.getFlag(FLAGS_KEY, TRAINING_KEY) || {};
  const choices = actor.getFlag(FLAGS_KEY, CHOICES_KEY) || {};
  const derivation = deriveActorTraining(actor, equipment, choices);
  const effective = effectiveItemLevels(equipment, manual, derivation.training);

  return {
    manual,
    derived: derivation.training,
    gaps: derivation.gaps,
    sources: derivation.sources,
    effective,
  };
}

// Asynchronously compute the actor's effective training and synchronize the
// actor's embedded catalog Items to it. Returns the compute result plus the
// `updates` array describing the embedded-document writes that were applied.
export async function syncActorRme(actor, equipment) {
  const result = computeActorTraining(actor, equipment);
  const updates = await syncActorItems(actor, equipment, result.effective);
  return { ...result, updates };
}
