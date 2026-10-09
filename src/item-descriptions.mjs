// Pure, browser-safe generation of concise item descriptions for RME
// equipment and ammunition.
//
// This module has no Foundry globals and no filesystem access, so it is safe
// to load in the Foundry runtime (browser-like) as well as under Node for
// tests. It only reads data passed to it and never mutates its inputs.
//
// It produces four pieces of text for an item:
//   - identifiedHtml:  the item's prose description (flavor text) only, with
//     the #####/name heading, italic stat line, armor table row, tier rows,
//     and the Expert Perk section stripped away, HTML-escaped inside <p>
//     blocks. When an entry carries no prose it falls back to a short generic
//     kind/group appearance that never mentions the entry name, weight,
//     price, tier, or perk.
//   - chatHtml:         the first complete prose sentence (or the first ~180
//     characters cut at a word boundary), HTML-escaped, with no name, stat
//     line, tier row, or perk.
//   - unidentifiedName: a generic category name ("Unidentified <group>",
//     "Unidentified Armor", "Unidentified Shield",
//     "Unidentified Natural Weapon", "Unidentified Ammunition").
//   - unidentifiedHtml: one generic non-mechanical appearance sentence that
//     never names the exact item, nor its properties, tier, or price.
//
// The source catalog keeps the full verbatim description in `entry.description`
// and the exact training tier rows in `entry.tiers`, so this module drops tier
// rows by matching against the actual `entry.tiers` rows (case-insensitively)
// rather than by a naive line-start scan. That keeps genuine prose paragraphs
// that happen to open with a tier word (e.g. the Unarmed Strike description
// "Untrained unarmed strikes are simple punches...") intact.

const SUFFIX = 'Module homebrew default - not RME source rule text.';

// The armor table row that leads an armor description (verbatim from the
// source, e.g. "Padded 11 Disadvantage 4 5").
const ARMOR_ROW_RE = /^(.+?)\s+(\d+)\s+(None|Disadvantage|Normal)\s+(\d+)\s+(\d+)\s*$/;

// The maximum length for a chat snippet, in characters.
const MAX_CHAT = 180;

// ---------------------------------------------------------------------------
// HTML escaping
// ---------------------------------------------------------------------------

function escapeHtml(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// ---------------------------------------------------------------------------
// Prose extraction (identified)
// ---------------------------------------------------------------------------

// Extract the prose (flavor) paragraphs from an equipment entry's description.
// Returns an array of paragraph strings, each with the leading bold item-name
// marker ("**Name** ") removed. Empty when the entry carries no prose.
function extractProseParagraphs(entry) {
  const description = String(entry.description || '');
  const lines = description.split('\n');
  const tierSet = new Set(
    (entry.tiers || []).map((t) => String(t).trim().toLowerCase())
  );

  const paragraphs = [];
  let current = [];
  let inPerk = false;

  const flush = () => {
    if (current.length > 0) {
      const joined = current.join(' ').replace(/\s+/g, ' ').trim();
      if (joined) paragraphs.push(joined);
      current = [];
    }
  };

  for (const line of lines) {
    const trimmed = line.trim();

    if (trimmed === '') {
      flush();
      continue;
    }

    // Once the Expert Perk heading appears, everything after it (including any
    // natural-weapon tables) is dropped.
    if (inPerk) continue;

    if (/^Expert Perk\b/i.test(trimmed)) {
      inPerk = true;
      flush();
      continue;
    }

    // The ##### name heading.
    if (/^#####\s/.test(trimmed)) {
      flush();
      continue;
    }

    // The two-form weapon sub-headings.
    if (/^(Sword Form|Whip Form)$/.test(trimmed)) {
      flush();
      continue;
    }

    // The italic stat line (e.g. "_Piercing, 12 lbs, 1000 gp_").
    if (/^_[^_]*_$/.test(trimmed)) {
      flush();
      continue;
    }

    // The armor table row that leads an armor description.
    if (ARMOR_ROW_RE.test(trimmed)) {
      flush();
      continue;
    }

    // An exact training tier row (matched against the catalog's own tiers).
    if (tierSet.has(trimmed.toLowerCase())) {
      flush();
      continue;
    }

    current.push(trimmed);
  }

  flush();

  // Strip a leading bold item-name marker ("**Padded** ") from a prose
  // paragraph so the item's own name is not repeated inside the identified
  // text (the name is already shown by the sheet heading).
  return paragraphs
    .map((p) => p.replace(/^\*\*[^*]+\*\*\s*/, '').trim())
    .filter(Boolean);
}

// A short generic kind/group appearance used when an entry carries no prose.
// Never mentions the entry name, weight, price, tier, or perk.
function fallbackIdentified(kind) {
  switch (kind) {
    case 'armor':
      return 'A set of armor, fitted and ready to protect its wearer.';
    case 'shield':
      return 'A sturdy shield, bearing the marks of careful craftsmanship.';
    case 'natural':
      return 'A natural weapon, honed by the body that wields it.';
    case 'weapon':
      return 'A well-made weapon, its design suggesting careful craft.';
    default:
      return 'A piece of equipment of unknown purpose.';
  }
}

// ---------------------------------------------------------------------------
// Chat / sentence extraction
// ---------------------------------------------------------------------------

// Period indices that belong to the "e.g." / "i.e." abbreviations, which never
// end a sentence. ("etc." is deliberately treated as a real sentence end so a
// list like "... pincers, talons, impale, etc." is not merged onward.)
function abbrevPeriodIndices(text) {
  const indices = new Set();
  const re = /e\.g\.?|i\.e\.?/gi;
  let m;
  while ((m = re.exec(text)) !== null) {
    const start = m.index;
    const end = start + m[0].length;
    for (let i = start; i < end; i++) {
      if (text[i] === '.') indices.add(i);
    }
  }
  return indices;
}

// Return the first complete sentence of `text` (stopping at the first '.', '!',
// or '?' that is not part of an abbreviation). Returns '' when there is none.
function firstSentence(text) {
  const t = String(text || '').trim();
  if (!t) return '';
  const skip = abbrevPeriodIndices(t);
  for (let i = 0; i < t.length; i++) {
    const ch = t[i];
    if ((ch === '.' || ch === '!' || ch === '?') && !skip.has(i)) {
      return t.slice(0, i + 1).trim();
    }
  }
  return t;
}

// Truncate `text` to `max` characters, backing off to the last word boundary
// (a space) at or before `max` so the snippet never cuts a word in half.
function truncateAtWordBoundary(text, max) {
  if (text.length <= max) return text;
  let cut = max;
  while (cut > 0 && text[cut] !== ' ' && text[cut - 1] !== ' ') cut--;
  if (cut <= 0) return text.slice(0, max).trim();
  return text.slice(0, cut).trim();
}

// The chat snippet for a text: the first complete prose sentence, or the first
// ~MAX_CHAT characters cut at a word boundary when the sentence is longer.
function chatText(text) {
  const sentence = firstSentence(text);
  if (!sentence) return '';
  return truncateAtWordBoundary(sentence, MAX_CHAT);
}

// ---------------------------------------------------------------------------
// Unidentified naming / description
// ---------------------------------------------------------------------------

function singularizeWord(word) {
  const w = String(word).trim();
  if (!w) return w;
  // Drop a trailing 's' for a simple plural; keep words that already end in a
  // double 's' (none in the catalog, guarded for safety).
  if (/s$/i.test(w) && !/ss$/i.test(w)) return w.slice(0, -1);
  return w;
}

// Singularize a weapon group's display name for the unidentified category
// ("Firearms" -> "Firearm", "Bows" -> "Bow", "Combat Blades" -> "Combat Blade").
function singularizeGroup(group) {
  return String(group || '')
    .trim()
    .split(/\s+/)
    .map(singularizeWord)
    .join(' ')
    .trim();
}

function unidentifiedNameFor(entry) {
  switch (entry.kind) {
    case 'armor':
      return 'Unidentified Armor';
    case 'shield':
      return 'Unidentified Shield';
    case 'natural':
      return 'Unidentified Natural Weapon';
    case 'weapon': {
      const singular = singularizeGroup(entry.group);
      return singular ? `Unidentified ${singular}` : 'Unidentified Weapon';
    }
    default:
      return 'Unidentified Item';
  }
}

function unidentifiedDescriptionFor(entry) {
  switch (entry.kind) {
    case 'armor':
      return 'You can tell it is a suit of armor, but its make and exact craft are unclear.';
    case 'shield':
      return 'You can tell it is a shield, but its make and exact craft are unclear.';
    case 'natural':
      return 'You can tell it is a natural weapon, but its exact form is unclear.';
    case 'weapon':
      return 'You can tell it is a weapon, but its make and exact craft are unclear.';
    default:
      return 'You can tell it is equipment, but its exact purpose is unclear.';
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

// Build the four description fields for an equipment (weapon / armor / shield
// / natural) catalog entry. Pure: never mutates `entry`.
export function equipmentDescriptions(entry) {
  const kind = entry && entry.kind ? entry.kind : null;
  const paragraphs = extractProseParagraphs(entry);

  let identifiedText;
  let identifiedHtml;
  if (paragraphs.length === 0) {
    identifiedText = fallbackIdentified(kind);
    identifiedHtml = `<p>${escapeHtml(identifiedText)}</p>`;
  } else {
    identifiedText = paragraphs.join(' ');
    identifiedHtml = paragraphs.map((p) => `<p>${escapeHtml(p)}</p>`).join('');
  }

  return {
    identifiedHtml,
    chatHtml: escapeHtml(chatText(identifiedText)),
    unidentifiedName: unidentifiedNameFor(entry),
    unidentifiedHtml: escapeHtml(unidentifiedDescriptionFor(entry)),
  };
}

// Build the four description fields for an ammunition entry. The identified
// text is the ammo's own description with the verbose "Module homebrew default
// - not RME source rule text." suffix removed. The mechanical effect is
// preserved separately as its own <p> block so no rules text (damage type,
// save DC, bonus, and so on) is lost. The unidentified name is always
// "Unidentified Ammunition". Pure: never mutates `ammoEntry`.
export function ammoDescriptions(ammoEntry) {
  const description = String(ammoEntry && ammoEntry.description ? ammoEntry.description : '');
  const withoutSuffix = description
    .replace(new RegExp(`\\s*${escapeRegex(SUFFIX)}$`, 'i'), '')
    .trim();
  const effectText = String(
    ammoEntry && ammoEntry.effect && ammoEntry.effect.text
      ? ammoEntry.effect.text
      : ''
  ).trim();

  const identifiedParts = [];
  if (withoutSuffix) identifiedParts.push(`<p>${escapeHtml(withoutSuffix)}</p>`);
  if (effectText) identifiedParts.push(`<p>${escapeHtml(effectText)}</p>`);
  const identifiedHtml = identifiedParts.join('');

  // Chat is derived from the flavor description (sans suffix); the effect text
  // is used only when there is no flavor text at all.
  const proseText = withoutSuffix || effectText || fallbackIdentified('weapon');

  return {
    identifiedHtml: identifiedHtml || `<p>${escapeHtml(fallbackIdentified('weapon'))}</p>`,
    chatHtml: escapeHtml(chatText(proseText)),
    unidentifiedName: 'Unidentified Ammunition',
    unidentifiedHtml: escapeHtml(
      'You can tell it is ammunition, but its exact make is unclear.'
    ),
  };
}

function escapeRegex(text) {
  return String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
