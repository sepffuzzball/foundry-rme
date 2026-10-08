// Pure mapping of module-managed ammunition effects to dnd5e roll bonuses,
// damage additions, and rider descriptors for RME Bows / Crossbows / Firearms.
//
// This module has no Foundry globals and no filesystem access, so it is safe to
// load in the Foundry runtime (browser-like) as well as under Node for tests.
// It only reads data passed to it (the data/ammunition.json catalog, either the
// parsed object with an `.ammunition` array or the array itself) and never
// mutates its inputs. Every value here is drawn directly from the catalog
// effect; nothing is invented. Only the explicitly approved mappings in the
// ammunition data are surfaced.
//
// The exported functions are read-only. Callers that need the catalog should
// load data/ammunition.json themselves and pass the parsed value.

// ---------------------------------------------------------------------------
// Catalog lookup
// ---------------------------------------------------------------------------

// The ammunition list from a passed catalog. Accepts either the array of ammo
// entries (the `.ammunition` array) or the parsed catalog object that carries
// that array, so callers are not forced into one shape.
function ammunitionList(ammoCatalog) {
  if (Array.isArray(ammoCatalog)) return ammoCatalog;
  if (ammoCatalog && Array.isArray(ammoCatalog.ammunition)) return ammoCatalog.ammunition;
  return [];
}

// The ammunition entry for an id, or null. A 'javelin' id (the Portable
// Ballista's fixed ammo sentinel) is intentionally not a catalog ammo entry, so
// it resolves to null without special-casing.
function findAmmo(ammoId, ammoCatalog) {
  const list = ammunitionList(ammoCatalog);
  return list.find((a) => a && a.id === ammoId) || null;
}

// ---------------------------------------------------------------------------
// Effect lookup
// ---------------------------------------------------------------------------

// The declarative effect object for an ammo id, or null when the id is unknown
// (including the 'javelin' sentinel). Returns the catalog object itself; it is a
// pure read and never mutates the catalog.
export function ammoEffect(ammoId, ammoCatalog) {
  const ammo = findAmmo(ammoId, ammoCatalog);
  return ammo?.effect ?? null;
}

// ---------------------------------------------------------------------------
// Roll bonuses
// ---------------------------------------------------------------------------

// The bonus this ammo grants to attack rolls: 0, 1, or 2. Drawn from the
// catalog effect's `attackBonus`; anything missing or non-finite is 0.
export function attackBonusFor(ammoId, ammoCatalog) {
  const effect = ammoEffect(ammoId, ammoCatalog);
  const bonus = Number(effect?.attackBonus);
  if (!Number.isFinite(bonus)) return 0;
  return Math.max(0, Math.floor(bonus));
}

// ---------------------------------------------------------------------------
// Damage additions
// ---------------------------------------------------------------------------

// The damage additions granted by an ammo effect as an array of
// `{ formula, type }` entries:
//   - a flat numeric bonus added to the weapon's EXISTING base damage only is
//     `{ formula: '+1', type: null }` (type null means "apply to base damage");
//   - an elemental arrow's extra damage is `{ formula: '1d4', type: 'fire' }`;
//   - an MPL area payload (grenade / incendiary) is `{ formula: '2d6',
//     type: 'bludgeoning' }` (a separate typed roll, not added to base weapon
//     damage - the area/save rider separates it from the weapon's own damage).
//
// No `{ formula, type }` entry is produced for ammo with no extra damage; the
// buckshot cone / one-fewer-die behavior is a separate rider descriptor, not a
// damage addition.
export function damageAdditionsFor(ammoId, ammoCatalog) {
  const effect = ammoEffect(ammoId, ammoCatalog);
  if (!effect) return [];

  const additions = [];

  // Flat bonus to existing base damage only (type null).
  const bonus = Number(effect.damageBonus);
  if (Number.isFinite(bonus) && bonus !== 0) {
    additions.push({ formula: `${bonus > 0 ? '+' : ''}${Math.floor(bonus)}`, type: null });
  }

  // Elemental arrow: typed extra damage on a hit.
  if (effect.extraDamage && typeof effect.extraDamage === 'object') {
    const extra = effect.extraDamage;
    if (extra.formula != null && extra.type != null) {
      additions.push({ formula: String(extra.formula), type: String(extra.type) });
    }
  }

  // MPL area payload: typed separate damage roll.
  if (effect.damage && typeof effect.damage === 'object') {
    const dmg = effect.damage;
    if (dmg.formula != null && dmg.type != null) {
      additions.push({ formula: String(dmg.formula), type: String(dmg.type) });
    }
  }

  return additions;
}

// ---------------------------------------------------------------------------
// Rider descriptors
// ---------------------------------------------------------------------------

// The rider descriptors of an ammo effect, drawn verbatim from the catalog:
// save (ability + dc), condition, radiusFeet, duration, and the half-on-save
// flag. Two catalog behaviors that are not literal fields are derived from the
// approved tags: `cone` is true when the effect carries the 'cone' tag and
// `fewerBaseDie` is true when it carries the 'spread' tag (the buckshot
// payload). Returns a stable shape with null / false defaults so callers can
// rely on every key being present.
export function riderFor(ammoId, ammoCatalog) {
  const effect = ammoEffect(ammoId, ammoCatalog);
  if (!effect) {
    return {
      save: null,
      condition: null,
      radiusFeet: null,
      duration: null,
      halfOnSave: false,
      cone: false,
      fewerBaseDie: false,
    };
  }

  const save = effect.save
    ? { ability: String(effect.save.ability), dc: Number(effect.save.dc) }
    : null;

  const tags = Array.isArray(effect.tags) ? effect.tags.map(String) : [];

  return {
    save,
    condition: effect.condition != null ? String(effect.condition) : null,
    radiusFeet: effect.radiusFeet != null ? Number(effect.radiusFeet) : null,
    duration: effect.duration != null ? String(effect.duration) : null,
    halfOnSave: Boolean(effect.halfOnSave),
    cone: tags.includes('cone'),
    fewerBaseDie: tags.includes('spread'),
  };
}

// ---------------------------------------------------------------------------
// Chat summary
// ---------------------------------------------------------------------------

// Escape HTML-special characters so the plain effect text is safe to insert
// into a chat message.
function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// A plain-text summary of the ammo effect, safe to show in chat. Returns the
// catalog effect's own `text` (HTML-escaped) so nothing is invented; an unknown
// or 'javelin' id yields an empty string.
export function effectSummary(ammoId, ammoCatalog) {
  const effect = ammoEffect(ammoId, ammoCatalog);
  if (!effect) return '';
  return escapeHtml(effect.text ?? '');
}
