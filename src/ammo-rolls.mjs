// User-approved ammunition roll MODIFIERS for module-managed ranged attacks.
//
// This layer sits on top of the pure planning (ammunition.mjs) and effect
// mapping (ammo-effects.mjs) modules. It is invoked AFTER the ammo feasibility
// gate in `handlePostAttackRollConfiguration` has already allowed a shot, so it
// never blocks a roll and never spends ammunition - it only:
//   - attaches ammunition provenance to the attack chat message;
//   - applies an approved +1/+2 attack roll bonus by appending DiceTerms to each
//     unevaluated attack roll; and
//   - (via handleAmmoDamageConfig) applies the approved damage additions to the
//     damage roll config, including the buckshot one-fewer-base-die reduction.
//
// It deliberately does NOT attempt to apply target conditions, saves, or area
// automation. Those are surfaced as descriptive rider text (ammoEffectDetails)
// and as a `rider` flag on the message for manual handling by the GM/players.
//
// There are NO Foundry globals referenced outside functions; every `game` /
// `foundry` access is inside a guarded helper so the module also loads and is
// testable under plain Node.

import { ammoFamily, magazineCapacity, readAmmoState, validAmmoIdForFamily } from './ammunition.mjs';
import {
  ammoEffect,
  attackBonusFor,
  damageAdditionsFor,
  effectSummary,
  riderFor,
} from './ammo-effects.mjs';
import { computeActorTraining } from './actor-training.mjs';

const ID = 'foundry-rme';
const JAVELIN_AMMO_ID = 'javelin';

// ---------------------------------------------------------------------------
// Lookup / compatibility helpers (mirrors the runtime's reads)
// ---------------------------------------------------------------------------

const catalogIdOf = (item) => item?.flags?.[ID]?.catalogId ?? null;

function isTaggedWeapon(item) {
  return Boolean(item && item.type === 'weapon' && catalogIdOf(item));
}

function findEntry(equipment, catalogId) {
  if (!equipment || !catalogId) return null;
  if (!Array.isArray(equipment)) return null;
  return equipment.find((e) => e && e.id === catalogId) || null;
}

function supportedWeaponEntry(equipment, item) {
  const entry = findEntry(equipment, catalogIdOf(item));
  if (!entry || ammoFamily(entry) == null) return null;
  return entry;
}

function isMeleeMode(mode) {
  return Boolean(mode && String(mode).startsWith('melee'));
}

function itemQuantity(item) {
  if (!item || typeof item !== 'object') return 0;
  const sys = item.system?.quantity;
  const top = item.quantity;
  const raw = sys !== undefined && sys !== null ? sys : top !== undefined && top !== null ? top : 0;
  const n = Number(raw);
  return Number.isFinite(n) ? Math.max(0, Math.floor(n)) : 0;
}

function resolveActorItem(actor, id) {
  if (!actor?.items || !id) return null;
  const get = actor.items.get;
  if (typeof get === 'function') return get.call(actor.items, id) || null;
  if (Array.isArray(actor.items)) return actor.items.find((i) => (i._id ?? i.id) === id) || null;
  return null;
}

// Resolve the weapon FRESH from the actor's live item collection (never the
// activity's possibly-cloned item) so the current ammo state is authoritative.
// Falls back to the passed item when the live lookup misses.
function freshWeaponItem(actor, item) {
  const resolved = resolveActorItem(actor, item?.id ?? item?._id);
  return resolved ?? item;
}

function effectiveLevel(actor, entry, equipment) {
  try {
    const picture = computeActorTraining(actor, equipment);
    return picture.effective?.items?.[entry.id] ?? 'untrained';
  } catch {
    return 'untrained';
  }
}

// ---------------------------------------------------------------------------
// Ammo provenance resolution
// ---------------------------------------------------------------------------

// The current ammo id for a shot:
//   - a magazine weapon (capacity > 0) uses the LOADED ammo id, even when it
//     differs from the assigned reserve stack;
//   - a direct-consumption weapon (capacity 0) uses the assigned reserve stack's
//     `flags['foundry-rme'].ammoId`; for the Portable Ballista (family 'javelin')
//     the fixed sentinel `'javelin'` is returned.
function ammoIdForWeapon(weapon, entry, level, actor) {
  const capacity = magazineCapacity(entry, level);
  const state = readAmmoState(weapon);
  if (capacity > 0) return state.loadedAmmoId || null;
  if (ammoFamily(entry) === 'javelin') return JAVELIN_AMMO_ID;
  const reserveId = state.reserveItemId;
  const reserve = reserveId ? resolveActorItem(actor, reserveId) : null;
  return reserve?.flags?.[ID]?.ammoId ?? null;
}

// Whether a single shot is currently possible. A magazine weapon needs a loaded
// round; a direct-consumption weapon needs an existing reserve stack with a
// positive quantity. Spending is NOT performed here.
function hasAmmoSource(weapon, entry, level, actor) {
  const capacity = magazineCapacity(entry, level);
  const state = readAmmoState(weapon);
  if (capacity > 0) {
    return (state.loaded ?? 0) > 0;
  }
  const reserveId = state.reserveItemId;
  const reserve = reserveId ? resolveActorItem(actor, reserveId) : null;
  return Boolean(reserve && itemQuantity(reserve) > 0);
}

function findAmmoEntry(ammoId, ammoCatalog) {
  const list = Array.isArray(ammoCatalog) ? ammoCatalog : ammoCatalog?.ammunition;
  if (!Array.isArray(list)) return null;
  return list.find((a) => a && a.id === ammoId) || null;
}

function ammoNameFor(ammoId, ammoCatalog) {
  return findAmmoEntry(ammoId, ammoCatalog)?.name ?? null;
}

// ---------------------------------------------------------------------------
// Message provenance helpers
// ---------------------------------------------------------------------------

// Set a key under `flags['foundry-rme']` on a chat message data object while
// preserving every other flag/scope already present.
function setMessageFlag(messageData, key, value) {
  const flags = { ...(messageData.flags || {}) };
  const rme = { ...(flags[ID] || {}) };
  rme[key] = value;
  flags[ID] = rme;
  messageData.flags = flags;
}

// ---------------------------------------------------------------------------
// Dice term builders (guarded against a missing Foundry terms library)
// ---------------------------------------------------------------------------

function isClassConstructor(fn) {
  return typeof fn === 'function' && /^\s*class\s/.test(Function.prototype.toString.call(fn));
}

function makeOperatorTerm(termsLib) {
  const Ctor = termsLib.OperatorTerm;
  if (isClassConstructor(Ctor)) return new Ctor({ operator: '+' });
  return Ctor('+');
}

function makeNumericTerm(termsLib, bonus) {
  const Ctor = termsLib.NumericTerm;
  const options = { flavor: 'RME ammunition' };
  if (isClassConstructor(Ctor)) return new Ctor({ number: bonus, options });
  return Ctor({ number: bonus, options });
}

// ---------------------------------------------------------------------------
// Flat / rider descriptors
// ---------------------------------------------------------------------------

function parseNumeric(formula) {
  const n = Number(String(formula).replace(/^[+\-]/, ''));
  return Number.isFinite(n) ? Math.floor(n) : 0;
}

// The approved flat damage bonus (type-null addition) for an ammo id, or 0.
function flatDamageBonus(ammoId, ammoCatalog) {
  return damageAdditionsFor(ammoId, ammoCatalog)
    .filter((a) => a.type == null)
    .reduce((sum, a) => sum + parseNumeric(a.formula), 0);
}

const ABILITY_NAMES = {
  str: 'Strength',
  dex: 'Dexterity',
  con: 'Constitution',
  int: 'Intelligence',
  wis: 'Wisdom',
  cha: 'Charisma',
};

const CONDITION_LABELS = {
  prone: 'prone',
  goaded: 'goaded',
  blinded: 'blinded',
  'heavily-obscured': 'heavily obscured',
};

function conditionLabel(condition) {
  return CONDITION_LABELS[condition] || String(condition);
}

function describeSave(rider) {
  const ability = ABILITY_NAMES[rider.save?.ability] || String(rider.save?.ability || 'unknown');
  let text = `The target must succeed on a ${ability} saving throw (DC ${rider.save?.dc})`;
  if (rider.condition) text += ` or be ${conditionLabel(rider.condition)}`;
  if (rider.duration) text += ` until ${rider.duration}`;
  return `${text}.`;
}

function describeCondition(rider) {
  const area = rider.radiusFeet != null;
  let text = `${area ? 'The area' : 'The target'} is ${conditionLabel(rider.condition)}`;
  if (rider.duration) text += ` for ${rider.duration}`;
  return `${text}.`;
}

// ---------------------------------------------------------------------------
// handleAmmoAttackRoll
// ---------------------------------------------------------------------------

// Apply approved attack-roll modifiers and attach ammunition provenance for a
// supported non-melee ranged attack on an actor-owned tagged RME weapon. Passed
// `rolls`, `config`, `dialog`, `message`, `equipment` and `ammoCatalog` mirror
// the dnd5e postAttackRollConfiguration call made from handlePostAttackRollConfiguration
// AFTER the ammo feasibility gate has allowed the shot.
//
// Never throws. Returns a descriptor:
//   { handled:boolean, applied:boolean, ammoId, ammoName, attackBonus,
//     damageBonus, effectText, reason }
// where `handled` is true for a valid supported attack and `applied` is true
// only when a +1/+2 attack bonus was written to at least one unevaluated roll.
// When `globalThis.foundry.dice.terms` is unavailable the modifier is reported
// via `reason: 'terms-unavailable'` rather than thrown.
export function handleAmmoAttackRoll(rolls, config, dialog, message, equipment, ammoCatalog) {
  const activity = config?.subject;
  if (!activity || activity.type !== 'attack') return { handled: false, applied: false };
  const actor = activity?.actor;
  const item = activity?.item;
  if (!actor?.isOwner) return { handled: false, applied: false };
  if (!isTaggedWeapon(item)) return { handled: false, applied: false };
  const entry = supportedWeaponEntry(equipment, item);
  if (!entry) return { handled: false, applied: false };
  const mode = rolls?.[0]?.options?.attackMode ?? config?.attackMode;
  if (isMeleeMode(mode)) return { handled: false, applied: false };

  const weapon = freshWeaponItem(actor, item);
  const level = effectiveLevel(actor, entry, equipment);
  const ammoId = ammoIdForWeapon(weapon, entry, level, actor);
  if (ammoId == null) return { handled: true, applied: false, ammoId: null, reason: 'no-ammo' };
  // The resolved ammo id must belong to this weapon's ammo family (the javelin
  // sentinel is a member of the 'javelin' family). An id from another family is
  // not a provenance match, so no flags/bonus are written for it.
  if (!validAmmoIdForFamily(ammoId, ammoFamily(entry))) {
    return { handled: true, applied: false, ammoId, reason: 'invalid-ammo' };
  }
  if (!hasAmmoSource(weapon, entry, level, actor)) {
    return { handled: true, applied: false, ammoId, reason: 'empty' };
  }

  const ammoName = ammoNameFor(ammoId, ammoCatalog);
  const bonus = attackBonusFor(ammoId, ammoCatalog);
  const damageBonus = flatDamageBonus(ammoId, ammoCatalog);
  const effectText = effectSummary(ammoId, ammoCatalog);

  // Attach provenance to the attack chat, preserving other flags.
  if (message?.data) {
    setMessageFlag(message.data, 'ammoId', ammoId);
    setMessageFlag(message.data, 'weaponCatalogId', entry.id);
    if (effectText) setMessageFlag(message.data, 'ammoEffectText', effectText);
  }

  if (bonus <= 0) {
    return {
      handled: true,
      applied: false,
      ammoId,
      ammoName,
      attackBonus: bonus,
      damageBonus,
      effectText,
    };
  }

  const termsLib = globalThis.foundry?.dice?.terms;
  if (!termsLib || typeof termsLib.OperatorTerm !== 'function' || typeof termsLib.NumericTerm !== 'function') {
    return {
      handled: true,
      applied: false,
      ammoId,
      ammoName,
      attackBonus: bonus,
      damageBonus,
      effectText,
      reason: 'terms-unavailable',
    };
  }

  let termsApplied = false;
  for (const roll of Array.isArray(rolls) ? rolls : []) {
    if (!roll || roll.evaluated) continue;
    if (!Array.isArray(roll.terms)) continue;
    if (roll.options?.rmeAmmoApplied) continue;

    roll.terms.push(makeOperatorTerm(termsLib));
    roll.terms.push(makeNumericTerm(termsLib, bonus));
    roll.options = { ...(roll.options || {}), rmeAmmoApplied: true };
    if (typeof roll.resetFormula === 'function') roll.resetFormula();
    termsApplied = true;
  }

  return {
    handled: true,
    applied: termsApplied,
    ammoId,
    ammoName,
    attackBonus: bonus,
    damageBonus,
    effectText,
  };
}

// ---------------------------------------------------------------------------
// handleAmmoDamageConfig
// ---------------------------------------------------------------------------

// The chat card a damage roll is performed from, resolved via the click event's
// data-message-id. Returns null when the config is not a chat-card damage roll
// or the message cannot be looked up.
function damageSourceMessage(config) {
  const event = config?.event;
  if (!event) return null;
  const element = event.target ?? event.currentTarget;
  const closest = typeof element?.closest === 'function' ? element.closest('[data-message-id]') : null;
  const messageId = closest?.dataset?.messageId;
  if (!messageId) return null;
  const messages = globalThis.game?.messages;
  const message = typeof messages?.get === 'function' ? messages.get(messageId) : null;
  return message || null;
}

function messageAmmoId(message) {
  if (!message) return null;
  const fromFlag =
    typeof message.getFlag === 'function' ? message.getFlag(ID, 'ammoId') : null;
  return fromFlag ?? message.flags?.[ID]?.ammoId ?? null;
}

// The weapon catalog id stamped on the originating attack card. Null when absent
// (a legacy card) or unreadable.
function weaponCatalogIdFromMessage(message) {
  if (!message) return null;
  const fromFlag =
    typeof message.getFlag === 'function' ? message.getFlag(ID, 'weaponCatalogId') : null;
  return fromFlag ?? message.flags?.[ID]?.weaponCatalogId ?? null;
}

function ammoIdFromAmmunition(config) {
  const ammo = config?.ammunition;
  if (!ammo) return null;
  const fromFlag = typeof ammo.getFlag === 'function' ? ammo.getFlag(ID, 'ammoId') : null;
  return fromFlag ?? ammo.flags?.[ID]?.ammoId ?? null;
}

// The ammo id for a damage roll comes ONLY from the originating chat card
// (which handleAmmoAttackRoll tagged) or from the config's explicit ammunition;
// there is deliberately NO fallback to the weapon's current ammo, so a chat
// damage roll always reflects the shot it belongs to. When an event card is
// present it is authoritative: a card that lacks an ammoId (or whose
// weaponCatalogId did not match, already rejected by applicableDamageEntry)
// never falls back to config.ammunition - that would silently mislabel a shot
// with ammo it never used.
function resolveDamageAmmoId(config) {
  const sourceMessage = damageSourceMessage(config);
  const fromEvent = messageAmmoId(sourceMessage);
  if (sourceMessage) return fromEvent;
  return fromEvent ?? ammoIdFromAmmunition(config);
}

// Resolve the RME-relevant equipment entry (or null) for a damage config: a
// tagged, actor-owned, supported ranged attack activity (dnd5e6
// ActivityMixin.rollDamage sets config.subject to the activity). When the ammo
// id came from a chat card, that card's `weaponCatalogId` flag must match THIS
// weapon's entry id, so an ammo bonus from another weapon's attack card never
// leaks into this damage roll. A legacy card without the flag is safest treated
// as a no-op.
function applicableDamageEntry(config, equipment) {
  const subject = config?.subject;
  if (!subject) return null;
  if (subject.type !== 'attack') return null;
  const actor = subject.actor;
  const item = subject.item;
  if (!actor?.isOwner) return null;
  if (!isTaggedWeapon(item)) return null;
  const entry = supportedWeaponEntry(equipment, item);
  if (!entry) return null;
  const mode = config?.rolls?.[0]?.options?.attackMode ?? config?.attackMode;
  if (isMeleeMode(mode)) return null;

  // A chat-card ammo id must belong to the same weapon as the subject: reject a
  // card stamped for a different entry, and never apply on a legacy card that
  // lacks the flag (no blind apply).
  const sourceMessage = damageSourceMessage(config);
  if (sourceMessage) {
    const cardCatalogId = weaponCatalogIdFromMessage(sourceMessage);
    if (cardCatalogId == null) return null;
    if (cardCatalogId !== entry.id) return null;
  }
  return entry;
}

// Apply the approved damage additions for a chat damage roll config:
//   - a flat +N damage bonus is appended to the first roll's base parts;
//   - elemental extra damage is appended as a separate typed roll;
//   - buckshot reduces ONE base die (NdM, N>=2) and leaves ambiguous formulas
//     unchanged; and
//   - MPL area payload (2d6) is NOT added to weapon damage.
// A `rider` descriptor is attached to the message for manual target handling.
export function handleAmmoDamageConfig(config, dialog, message, equipment, ammoCatalog) {
  const entry = applicableDamageEntry(config, equipment);
  if (!entry) {
    return { handled: false, applied: false };
  }

  const ammoId = resolveDamageAmmoId(config);
  if (!ammoId) return { handled: false, applied: false, reason: 'no-ammo-id' };

  // The resolved ammo id must be a valid id for this weapon's ammo family (the
  // javelin sentinel is a member of the 'javelin' family). An id from another
  // family is not a provenance match, so the damage roll is left untouched.
  if (!validAmmoIdForFamily(ammoId, ammoFamily(entry))) {
    return { handled: false, applied: false, ammoId, reason: 'invalid-ammo' };
  }

  const ammoEntry = findAmmoEntry(ammoId, ammoCatalog);
  const family = ammoEntry?.family ?? null;
  const rider = riderFor(ammoId, ammoCatalog);

  if (message?.data) {
    setMessageFlag(message.data, 'ammoId', ammoId);
    setMessageFlag(message.data, 'rider', rider);
  }

  const rolls = config?.rolls;
  if (!Array.isArray(rolls) || rolls.length === 0) {
    return { handled: true, applied: false, ammoId, reason: 'no-rolls' };
  }

  if (config.rmeAmmoDamageApplied) {
    return { handled: true, applied: false, ammoId, reason: 'already-applied' };
  }

  const first = rolls[0];
  const parts = Array.isArray(first?.parts) ? first.parts : [];

  // Buckshot: reduce one base damage die only when the first base part is a
  // numeric NdM (N>=2); ambiguous formulas are left unchanged.
  if (rider.fewerBaseDie && parts.length > 0) {
    const base = String(parts[0]);
    const match = /^(\d+)d(\d+)$/.exec(base);
    if (match && Number(match[1]) >= 2) {
      parts[0] = `${Number(match[1]) - 1}d${match[2]}`;
    }
  }

  for (const addition of damageAdditionsFor(ammoId, ammoCatalog)) {
    if (addition.type == null) {
      // Flat approved bonus to the weapon's base damage only. Push a plain
      // numeric string (not '+1'/'+2') so the dnd5e BasicRoll ' + ' join of
      // `parts` never builds a malformed '2d8 + +1' double-plus formula.
      const bonusNum = parseNumeric(addition.formula);
      parts.push(String(bonusNum));
    } else if (family !== 'mpl') {
      // Elemental arrow extra damage: a separate typed roll. MPL area payload
      // (2d6) is excluded here - it is a blast/save rider, not on-hit.
      rolls.push({ parts: [String(addition.formula)], options: { type: String(addition.type) } });
    }
  }

  config.rmeAmmoDamageApplied = true;
  return { handled: true, applied: true, ammoId, reason: null };
}

// ---------------------------------------------------------------------------
// ammoEffectDetails
// ---------------------------------------------------------------------------

// A human-readable, approved description of the ammo's on-hit rider (save,
// condition, area, duration) built only from catalog data, for DISPLAY. It
// never applies a condition; it only describes it. An ammo with no rider falls
// back to the catalog effect text.
export function ammoEffectDetails(ammoId, ammoCatalog) {
  const effect = ammoEffect(ammoId, ammoCatalog);
  if (!effect) return '';
  const rider = riderFor(ammoId, ammoCatalog);
  const parts = [];

  if (rider.cone && rider.fewerBaseDie) {
    parts.push(`Fires in a ${rider.radiusFeet}-foot cone and uses one fewer base damage die.`);
  } else if (rider.cone) {
    parts.push(`Fires in a ${rider.radiusFeet}-foot cone.`);
  } else if (rider.fewerBaseDie) {
    parts.push('Uses one fewer base damage die.');
  } else if (rider.radiusFeet != null) {
    parts.push(`Bursts in a ${rider.radiusFeet}-foot radius.`);
  }

  if (rider.save) parts.push(describeSave(rider));
  else if (rider.condition) parts.push(describeCondition(rider));

  if (rider.halfOnSave) parts.push('Half damage on a successful save.');

  if (parts.length === 0) return String(effect.text ?? '');
  return parts.join(' ');
}
