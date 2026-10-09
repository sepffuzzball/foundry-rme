import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  equipmentDescriptions,
  ammoDescriptions,
} from '../src/item-descriptions.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const catalog = JSON.parse(
  readFileSync(join(__dirname, '..', 'data', 'catalog.json'), 'utf8')
);
const ammunition = JSON.parse(
  readFileSync(join(__dirname, '..', 'data', 'ammunition.json'), 'utf8')
).ammunition;

function entry(id) {
  const e = catalog.equipment.find((x) => x.id === id);
  assert.ok(e, `missing catalog entry ${id}`);
  return e;
}

function stripTags(html) {
  return String(html).replace(/<\/?p>/g, '');
}

function unescapeHtml(s) {
  return String(s)
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

const rifle = entry('firearms/bolt-action-rifle');
const buckler = entry('shields/buckler');
const claw = entry('natural-weapons/claw');
const grappleCrossbow = entry('crossbows/grapple-crossbow');

// ---------------------------------------------------------------------------
// Rifle fixture: one prose paragraph only, no stats / tiers / perk.
// ---------------------------------------------------------------------------

test('rifle identified description keeps the prose paragraph only', () => {
  const d = equipmentDescriptions(rifle);

  const prose =
    'A relic from the Broken World, this cartridge-fed integral-tube ' +
    'full-length rifle has a single barrel and fires a very large projectile ' +
    'with tons of powder and extra stopping force, though it tends to be ' +
    'unwieldy and a bit more difficult to use in close quarters.';

  assert.equal(d.identifiedHtml, `<p>${prose}</p>`);
  assert.ok(stripTags(d.identifiedHtml).includes('A relic from the Broken World'));
  assert.equal(d.identifiedHtml.includes('#####'), false);
  assert.equal(d.identifiedHtml.includes('_Piercing'), false);
  assert.equal(d.identifiedHtml.includes('12 lbs'), false);
  assert.equal(d.identifiedHtml.includes('1000 gp'), false);
  assert.equal(d.identifiedHtml.includes('Untrained'), false);
  assert.equal(d.identifiedHtml.includes('Basic'), false);
  assert.equal(d.identifiedHtml.includes('Expert Perk'), false);
});

test('rifle chat is a short word-boundary snippet with no stats', () => {
  const d = equipmentDescriptions(rifle);

  assert.ok(d.chatHtml.length > 0);
  assert.ok(d.chatHtml.length <= 180);
  assert.equal(d.chatHtml.includes('12 lbs'), false);
  assert.equal(d.chatHtml.includes('1000 gp'), false);
  assert.equal(d.chatHtml.includes('#####'), false);
  assert.equal(d.chatHtml.includes('Untrained'), false);
  assert.equal(d.chatHtml.includes('Expert Perk'), false);
  assert.equal(d.chatHtml.endsWith('stopping'), true);
});

test('rifle unidentified is a generic weapon category', () => {
  const d = equipmentDescriptions(rifle);

  assert.equal(d.unidentifiedName, 'Unidentified Firearm');
  assert.ok(d.unidentifiedHtml.length > 0);
  assert.equal(d.unidentifiedHtml.includes('Bolt-Action Rifle'), false);
  assert.equal(d.unidentifiedHtml.includes('1000 gp'), false);
});

// ---------------------------------------------------------------------------
// Armor table-only fallback: no prose, so a generic kind appearance is used.
// ---------------------------------------------------------------------------

test('armor with only a table row falls back to a generic description', () => {
  const tableOnly = {
    id: 'test/table-only-armor',
    group: 'Armor',
    name: 'Padded',
    kind: 'armor',
    description: 'Padded 11 Disadvantage 4 5',
    tiers: [],
  };
  const d = equipmentDescriptions(tableOnly);

  assert.ok(d.identifiedHtml.length > 0);
  assert.ok(d.identifiedHtml.includes('A set of armor'));
  assert.equal(d.identifiedHtml.includes('Padded'), false);
  assert.equal(d.identifiedHtml.includes('Disadvantage'), false);
  assert.equal(d.identifiedHtml.includes('11'), false);
  assert.equal(d.unidentifiedName, 'Unidentified Armor');
  assert.ok(d.unidentifiedHtml.length > 0);
});

// ---------------------------------------------------------------------------
// Shield and natural fixtures.
// ---------------------------------------------------------------------------

test('shield identified keeps prose and drops tier rows', () => {
  const d = equipmentDescriptions(buckler);

  assert.ok(d.identifiedHtml.includes('A buckler, or target, is a hand shield'));
  assert.ok(d.identifiedHtml.includes('perfect riposte'));
  assert.equal(d.identifiedHtml.includes('_+1 AC'), false);
  assert.equal(d.identifiedHtml.includes('2 lbs'), false);
  assert.equal(d.identifiedHtml.includes('Basic The buckler'), false);
  assert.equal(d.identifiedHtml.includes('Expert You can add'), false);
  assert.equal(d.identifiedHtml.includes('#####'), false);
  assert.equal(d.chatHtml.length > 0, true);
});

test('natural weapon identified keeps prose and drops tiers/perk', () => {
  const d = equipmentDescriptions(claw);

  assert.ok(d.identifiedHtml.includes('This listing can be used for any other Natural weapons'));
  assert.equal(d.identifiedHtml.includes('_Piercing'), false);
  assert.equal(d.identifiedHtml.includes('Proficient Finesse'), false);
  assert.equal(d.identifiedHtml.includes('Expert Finesse'), false);
  assert.equal(d.identifiedHtml.includes('Expert Perk'), false);
  assert.equal(d.unidentifiedName, 'Unidentified Natural Weapon');
  assert.ok(d.unidentifiedHtml.length > 0);
  assert.equal(d.unidentifiedHtml.includes('Claw'), false);
});

// ---------------------------------------------------------------------------
// Two-paragraph grapple crossbow.
// ---------------------------------------------------------------------------

test('two-paragraph crossbow preserves both prose paragraphs', () => {
  const d = equipmentDescriptions(grappleCrossbow);

  const paragraphCount = (d.identifiedHtml.match(/<p>/g) || []).length;
  assert.equal(paragraphCount, 2);
  assert.ok(d.identifiedHtml.includes('This heavy crossbow has a coiled silk rope'));
  assert.ok(d.identifiedHtml.includes('When entangling an enemy'));
  assert.equal(d.identifiedHtml.includes('13 lbs'), false);
  assert.equal(d.identifiedHtml.includes('175 gp'), false);
  assert.equal(d.identifiedHtml.includes('Untrained Awkward'), false);

  assert.ok(d.chatHtml.length > 0);
  assert.equal(d.chatHtml.includes('13 lbs'), false);
  assert.equal(d.chatHtml.includes('175 gp'), false);
  assert.equal(d.unidentifiedName, 'Unidentified Crossbow');
});

// ---------------------------------------------------------------------------
// HTML injection is escaped.
// ---------------------------------------------------------------------------

test('identified and chat HTML are escaped', () => {
  const xss = {
    id: 'test/xss',
    group: 'Test',
    name: 'XSS',
    kind: 'weapon',
    description:
      '##### XSS\n\n_Slashing, 1 lb, 1 gp_\n\n' +
      '<b>Bold</b> <script>alert("x")</script>',
    tiers: ['Untrained One-Handed, Melee d6'],
  };
  const d = equipmentDescriptions(xss);

  assert.ok(d.identifiedHtml.includes('&lt;b&gt;Bold&lt;/b&gt;'));
  assert.ok(d.identifiedHtml.includes('&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;'));
  assert.ok(d.chatHtml.includes('&lt;b&gt;Bold&lt;/b&gt;'));
  assert.equal(d.identifiedHtml.includes('<script>'), false);
  assert.equal(d.identifiedHtml.includes('_Slashing'), false);
});

// ---------------------------------------------------------------------------
// Every catalog entry: identified text is prose-only and non-empty.
// ---------------------------------------------------------------------------

test('every catalog entry yields a prose-only, non-empty identified description', () => {
  for (const e of catalog.equipment) {
    const d = equipmentDescriptions(e);
    const raw = stripTags(d.identifiedHtml);

    assert.ok(raw.length > 0, `${e.id}: empty identified`);
    assert.equal(d.identifiedHtml.includes('#####'), false, `${e.id}: heading`);
    assert.equal(
      d.identifiedHtml.toLowerCase().includes('expert perk'),
      false,
      `${e.id}: perk`
    );
    assert.equal(raw.includes('_'), false, `${e.id}: stat line`);
    for (const tier of e.tiers || []) {
      assert.equal(
        d.identifiedHtml.includes(tier),
        false,
        `${e.id}: tier row leaked`
      );
    }
    assert.ok(d.chatHtml.length > 0, `${e.id}: empty chat`);
    assert.ok(unescapeHtml(d.chatHtml).length <= 180, `${e.id}: chat too long`);
    assert.equal(
      d.chatHtml.toLowerCase().includes('expert perk'),
      false,
      `${e.id}: chat perk`
    );
    assert.ok(d.unidentifiedName.length > 0, `${e.id}: empty name`);
    assert.ok(d.unidentifiedHtml.length > 0, `${e.id}: empty unidentified`);
    assert.equal(
      d.unidentifiedHtml.toLowerCase().includes(e.name.toLowerCase()),
      false,
      `${e.id}: unidentified names the item`
    );
  }
});

// ---------------------------------------------------------------------------
// Ammunition: no cost is invented, suffix is removed, effect is preserved.
// ---------------------------------------------------------------------------

test('all ammunition descriptions drop the homebrew suffix and invent no cost', () => {
  for (const ammo of ammunition) {
    const d = ammoDescriptions(ammo);

    assert.ok(d.identifiedHtml.length > 0, `${ammo.id}: empty identified`);
    assert.equal(
      d.identifiedHtml.includes('Module homebrew default'),
      false,
      `${ammo.id}: suffix not removed`
    );
    assert.equal(
      d.chatHtml.length > 0,
      true,
      `${ammo.id}: empty chat`
    );
    assert.equal(d.unidentifiedName, 'Unidentified Ammunition');

    for (const html of [d.identifiedHtml, d.chatHtml, d.unidentifiedHtml]) {
      assert.equal(
        /\b\d+\s*(gp|sp|cp)\b/i.test(html),
        false,
        `${ammo.id}: invented cost in ${html}`
      );
    }
    assert.ok(d.unidentifiedHtml.length > 0, `${ammo.id}: empty unidentified`);
  }
});

test('ammunition keeps the mechanical effect separately', () => {
  const bolts = ammunition.find((a) => a.id === 'crossbow/bolts');
  const d = ammoDescriptions(bolts);

  assert.ok(d.identifiedHtml.includes('Deals piercing damage.'));
  // The description text itself is preserved verbatim (minus the suffix).
  assert.ok(d.identifiedHtml.includes('A standard crossbow bolt.'));
});
