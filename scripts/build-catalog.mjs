#!/usr/bin/env node
// Builds data/catalog.json from the verbatim markdown in rules/.
//
// Output schema:
//   {
//     "schemaVersion": 1,
//     "equipment": [ { id, group, name, kind, source, description, tiers, expertPerk } ],
//     "references": [ { id, title, source, content } ]
//   }
//
// Equipment is extracted from the 17 named weapon-group files. Two informational
// sections are excluded: "Extended Polearm Group" (Polearms.md) and
// "Training with Shields" (Shields.md). The 12 armor table rows in Armor.md are
// added as `kind: "armor"` entries, each paired with its matching descriptive
// paragraph from Armor.md when one is present. Every rules/*.md file is included
// verbatim as a reference.
//
// Validation (fails loudly, before any output is written):
//   - total equipment entries == 173 (145 weapons + 8 natural + 8 shields + 12 armor)
//   - per-kind counts match the expected breakdown
//   - every id is unique
//   - every non-armor entry has at least one tier row
//   - every equipment source file exists and every rules/*.md file is referenced

import {
  readFileSync,
  readdirSync,
  writeFileSync,
  mkdirSync,
} from 'node:fs';
import { join, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const RULES_DIR = join(__dirname, '..', 'rules');
const DATA_DIR = join(__dirname, '..', 'data');
const OUT_FILE = join(DATA_DIR, 'catalog.json');

const SCHEMA_VERSION = 1;
const EXPECTED_TOTAL = 173; // 145 weapons + 8 natural + 8 shields + 12 armor

// Expected equipment count by kind.
const EXPECTED_COUNTS = {
  weapon: 145, // standard non-shield, non-natural weapons
  natural: 8, // blocks extracted from NaturalWeapons.md
  shield: 8, // blocks extracted from Shields.md (excluding the info section)
  armor: 12, // rows extracted from the Armor.md tables
};

// The 17 named weapon-group files to extract equipment from.
const GROUP_FILES = [
  'AmbushWeapons',
  'Axes',
  'Bludgeons',
  'Bows',
  'CombatBlades',
  'Crossbows',
  'DuelingBlades',
  'Firearms',
  'Flails',
  'HammersPicks',
  'LaunchWeapons',
  'NaturalWeapons',
  'Polearms',
  'Shields',
  'Spears',
  'ThrowingWeapons',
  'Whips',
];

// Informational sections that appear as `#####` headings but are not equipment
// blocks.
const EXCLUDED_SECTIONS = new Set(['Extended Polearm Group', 'Training with Shields']);

// Tier labels that begin a training row.
const TIER_LABELS = ['Untrained', 'Proficient', 'Basic', 'Expert'];

const GROUP_FILE_SET = new Set(GROUP_FILES);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function slugify(str) {
  return str
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function groupNameFromFile(base) {
  // "AmbushWeapons" -> "Ambush Weapons", "CombatBlades" -> "Combat Blades"
  return base.replace(/([a-z0-9])([A-Z])/g, '$1 $2');
}

// The equipment kind depends on the source file. Shields.md blocks are
// `shield`, NaturalWeapons.md blocks are `natural`, everything else `weapon`.
function kindForFile(base) {
  if (base === 'Shields') return 'shield';
  if (base === 'NaturalWeapons') return 'natural';
  return 'weapon';
}

function isEquipmentHeading(line) {
  return /^#####\s/.test(line);
}

// Canonical capitalization for each tier label. The source is inconsistent:
// the Light Crossbow's expert row is written lowercase ("expert ..."), so
// tier labels are normalized to their canonical form on extraction.
const TIER_LABEL_CANONICAL = {
  untrained: 'Untrained',
  proficient: 'Proficient',
  basic: 'Basic',
  expert: 'Expert',
};

// Normalize the leading tier label of a captured tier row to its canonical
// form while preserving the exact remainder of the row (including compressed
// rows such as "UntrainedAwkward, ...", which carry no space after the label).
function normalizeTierRow(row) {
  return row.replace(
    /^(untrained|proficient|basic|expert)(?=[ \tA-Za-z0-9]|$)/i,
    (m) => TIER_LABEL_CANONICAL[m.toLowerCase()]
  );
}

function isTierRow(line) {
  const t = line.trim();
  if (/^Expert Perk\b/i.test(t)) return false;
  // A tier row starts with a tier label (both cases are accepted, since the
  // source writes the Light Crossbow's expert row as lowercase "expert") and
  // is followed by a space + an uppercase letter/digit, an uppercase
  // letter/digit immediately, or is just the label. The `[A-Z0-9]` character
  // class stays case-sensitive so prose such as the Unarmed Strike description
  // line "Untrained unarmed strikes are simple punches..." is not taken for a
  // tier row.
  return /^(?:Untrained|untrained|Proficient|proficient|Basic|basic|Expert|expert)(?:\s+[A-Z0-9]|[A-Z0-9]|$)/.test(t);
}

function isFormHeading(line) {
  return /^(Sword Form|Whip Form)$/.test(line.trim());
}

function findNextEquipmentHeading(lines, start) {
  for (let i = start; i < lines.length; i++) {
    if (isEquipmentHeading(lines[i])) return i;
  }
  return lines.length;
}

// ---------------------------------------------------------------------------
// Equipment block parsing
// ---------------------------------------------------------------------------

// Returns { name, description, tiers, expertPerk }.
function parseEquipmentBlock(lines, headingName) {
  const description = lines.join('\n').trim();

  const tierRows = [];
  const perkSections = [];
  let inPerk = false;
  let currentPerk = [];

  // Skip the heading line; the rest is block body.
  for (let i = 1; i < lines.length; i++) {
    const raw = lines[i];
    const t = raw.trim();

    if (t === '') {
      if (inPerk) currentPerk.push('');
      continue;
    }

    if (/^Expert Perk\b/i.test(t)) {
      if (inPerk) {
        perkSections.push(currentPerk.join('\n').trim());
        currentPerk = [];
      }
      inPerk = true;
      continue;
    }

    if (isTierRow(raw)) {
      tierRows.push(normalizeTierRow(t));
      if (inPerk) {
        // A new tier row ends a previous perk section (only relevant for the
        // two-form Whip Sword, though the form heading normally ends it).
        perkSections.push(currentPerk.join('\n').trim());
        currentPerk = [];
        inPerk = false;
      }
      continue;
    }

    if (isFormHeading(raw)) {
      if (inPerk) {
        perkSections.push(currentPerk.join('\n').trim());
        currentPerk = [];
        inPerk = false;
      }
      continue;
    }

    if (inPerk) currentPerk.push(raw);
  }

  if (inPerk) perkSections.push(currentPerk.join('\n').trim());

  return {
    name: headingName.trim(),
    description,
    tiers: tierRows,
    expertPerk: perkSections.length > 0 ? perkSections.join('\n\n') : null,
  };
}

function extractWeaponBlocks(content, base) {
  const lines = content.split('\n');
  const blocks = [];

  let i = 0;
  while (i < lines.length) {
    if (isEquipmentHeading(lines[i])) {
      const name = lines[i].replace(/^#####\s+/, '').trim();
      if (!EXCLUDED_SECTIONS.has(name)) {
        const end = findNextEquipmentHeading(lines, i + 1);
        blocks.push(parseEquipmentBlock(lines.slice(i, end), name));
        i = end;
        continue;
      }
    }
    i++;
  }
  return blocks;
}

// ---------------------------------------------------------------------------
// Armor table parsing
// ---------------------------------------------------------------------------

// A row matches: <name> <AC> <Stealth> <Weight> <GoldCost>. The name may
// contain spaces ("Chain Shirt", "Scale Mail"). The non-greedy name capture
// stops at the first standalone integer that is followed by the stealth word.
function armorRowRegex() {
  return /^(.+?)\s+(\d+)\s+(None|Disadvantage|Normal)\s+(\d+)\s+(\d+)\s*$/;
}

function extractArmorRows(content) {
  const lines = content.split('\n');
  const rows = [];
  let inArmorTable = false;

  for (const line of lines) {
    const t = line.trim();

    if (/^##### (Light|Medium|Heavy) Armor$/.test(t)) {
      inArmorTable = true;
      continue;
    }

    // Any other `#####`, `####`, or `###` heading leaves a table.
    if (/^#{5,}\s/.test(t) || /^#{2,4}\s/.test(t)) {
      inArmorTable = false;
      continue;
    }

    if (!inArmorTable) continue;

    const m = t.match(armorRowRegex());
    if (m) {
      rows.push({
        name: m[1].trim(),
        ac: m[2],
        stealth: m[3],
        weight: m[4],
        cost: m[5],
        raw: t,
      });
    }
  }
  return rows;
}

// Extracts the named descriptive paragraphs from the Armor.md armor sections.
// Each entry is the verbatim `**Name** <description>` line that appears under
// the `#### Light Armor`, `#### Medium armor`, or `#### Heavy` headings.
function extractArmorDescriptions(content) {
  const lines = content.split('\n');
  const paragraphs = [];
  let inArmorSection = false;

  for (const line of lines) {
    const t = line.trim();

    if (/^#### (light armor|medium armor|heavy)$/i.test(t)) {
      inArmorSection = true;
      continue;
    }

    // Any heading of level 1-4 ends an armor section.
    if (/^#{1,4}\s/.test(t)) {
      inArmorSection = false;
      continue;
    }

    if (!inArmorSection) continue;

    const m = line.match(/^\*\*([^*]+)\*\*\s+(.+)$/);
    if (m) {
      paragraphs.push({ name: m[1].trim(), text: line.trim() });
    }
  }
  return paragraphs;
}

// Matches an armor table row to its descriptive paragraph by name, tolerating
// the source's abbreviated table names (e.g. "Studded" vs "Studded Leather",
// "Scale Mail" vs "Scale"). Returns null when no unambiguous match exists.
function findArmorParagraph(rowName, paragraphs) {
  const norm = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '');
  const rn = norm(rowName);

  const matches = paragraphs.filter((p) => {
    const pn = norm(p.name);
    if (!pn) return false;
    return pn === rn || pn.startsWith(rn) || rn.startsWith(pn);
  });

  if (matches.length === 0) return null;
  if (matches.length === 1) return matches[0];

  // Prefer an exact name match when several candidates exist.
  const exact = matches.filter((p) => norm(p.name) === rn);
  return exact.length === 1 ? exact[0] : null;
}

// ---------------------------------------------------------------------------
// References
// ---------------------------------------------------------------------------

function buildReference(relPath, filePath) {
  const content = readFileSync(filePath, 'utf8');
  const base = basename(relPath, '.md');

  // Title: first top-level markdown heading if present, else the filename.
  const m = content.match(/^#\s+(.+)$/m);
  const title = m ? m[1].trim() : base;

  return {
    id: slugify(base),
    title,
    source: relPath,
    content,
  };
}

// ---------------------------------------------------------------------------
// Entry assembly
// ---------------------------------------------------------------------------

function fail(message) {
  throw new Error(`[build-catalog] ${message}`);
}

function main() {
  const existingMarkdown = readdirSync(RULES_DIR)
    .filter((f) => f.endsWith('.md'))
    .sort();

  if (existingMarkdown.length !== 24) {
    fail(`expected 24 rules/*.md files, found ${existingMarkdown.length}`);
  }

  // Build references from every markdown file (verbatim).
  const references = existingMarkdown.map((f) =>
    buildReference(`rules/${f}`, join(RULES_DIR, f))
  );

  // Build equipment.
  const equipment = [];

  for (const base of GROUP_FILES) {
    const filePath = join(RULES_DIR, `${base}.md`);
    if (!existingMarkdown.includes(`${base}.md`)) {
      fail(`group file missing: rules/${base}.md`);
    }

    const groupName = groupNameFromFile(base);
    const groupSlug = slugify(groupName);
    const content = readFileSync(filePath, 'utf8');
    const blocks = extractWeaponBlocks(content, base);

    for (const block of blocks) {
      equipment.push({
        id: `${groupSlug}/${slugify(block.name)}`,
        group: groupName,
        name: block.name,
        kind: kindForFile(base),
        source: `rules/${base}.md`,
        description: block.description,
        tiers: block.tiers,
        expertPerk: block.expertPerk,
      });
    }
  }

  // Armor table rows.
  const armorContent = readFileSync(join(RULES_DIR, 'Armor.md'), 'utf8');
  const armorRows = extractArmorRows(armorContent);
  const armorParagraphs = extractArmorDescriptions(armorContent);
  for (const row of armorRows) {
    const paragraph = findArmorParagraph(row.name, armorParagraphs);
    const description = paragraph
      ? `${row.raw}\n\n${paragraph.text}`
      : row.raw;
    equipment.push({
      id: `armor/${slugify(row.name)}`,
      group: 'Armor',
      name: row.name,
      kind: 'armor',
      source: 'rules/Armor.md',
      description,
      tiers: [],
      expertPerk: null,
    });
  }

  // -------------------------------------------------------------------------
  // Validation (fails loudly on mismatch, before any output is written)
  // -------------------------------------------------------------------------

  const weaponCount = equipment.filter((e) => e.kind === 'weapon').length;
  const naturalCount = equipment.filter((e) => e.kind === 'natural').length;
  const shieldCount = equipment.filter((e) => e.kind === 'shield').length;
  const armorCount = equipment.filter((e) => e.kind === 'armor').length;
  const total = equipment.length;

  const ids = equipment.map((e) => e.id);
  const dupes = ids.filter((id, idx) => ids.indexOf(id) !== idx);
  const uniqueIds = new Set(ids).size;

  // Equipment sources must be existing markdown and referenced.
  const referenceSources = new Set(references.map((r) => r.source));
  const badSources = equipment
    .map((e) => e.source)
    .filter((s) => !referenceSources.has(s));

  // Every existing markdown file must be referenced.
  const unreferenced = existingMarkdown
    .map((f) => `rules/${f}`)
    .filter((s) => !referenceSources.has(s));

  const problems = [];
  if (total !== EXPECTED_TOTAL) {
    problems.push(
      `total equipment: expected ${EXPECTED_TOTAL}, got ${total} ` +
        `(weapons ${weaponCount}, natural ${naturalCount}, shields ${shieldCount}, armor ${armorCount})`
    );
  }
  for (const [kind, expected] of Object.entries(EXPECTED_COUNTS)) {
    const actual = equipment.filter((e) => e.kind === kind).length;
    if (actual !== expected) {
      problems.push(`expected ${expected} ${kind} entries, got ${actual}`);
    }
  }
  if (dupes.length > 0) {
    problems.push(`duplicate ids (${uniqueIds}/${ids.length} unique): ${[...new Set(dupes)].join(', ')}`);
  }
  const missingTiers = equipment
    .filter((e) => e.kind !== 'armor' && e.tiers.length === 0)
    .map((e) => e.id);
  if (missingTiers.length > 0) {
    problems.push(`non-armor entries missing tiers: ${missingTiers.join(', ')}`);
  }
  if (badSources.length > 0) {
    problems.push(`equipment sources not referenced: ${[...new Set(badSources)].join(', ')}`);
  }
  if (unreferenced.length > 0) {
    problems.push(`markdown files not referenced: ${unreferenced.join(', ')}`);
  }

  if (problems.length > 0) {
    fail(problems.join('\n'));
  }

  // All validation passed - now build and write the catalog.
  mkdirSync(DATA_DIR, { recursive: true });
  const catalog = {
    schemaVersion: SCHEMA_VERSION,
    equipment,
    references,
  };
  writeFileSync(OUT_FILE, `${JSON.stringify(catalog, null, 2)}\n`, 'utf8');

  console.log(
    `catalog written: ${OUT_FILE}\n` +
      `equipment: ${total} (weapons ${weaponCount}, natural ${naturalCount}, shields ${shieldCount}, armor ${armorCount})\n` +
      `references: ${references.length}\n` +
      `unique ids: ${uniqueIds}/${ids.length}`
  );
}

main();
