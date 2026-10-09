import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import catalog from '../data/catalog.json' with { type: 'json' };
import ammunition from '../data/ammunition.json' with { type: 'json' };
import iconMap from '../data/icon-map.json' with { type: 'json' };
import { ICON_MAP } from '../src/icon-map.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('every catalog item has an offline, attributed official SVG icon', () => {
  const ids = [...catalog.equipment, ...ammunition.ammunition].map(({ id }) => id);
  assert.equal(ids.length, 198);
  assert.equal(Object.keys(iconMap).length, ids.length);
  assert.deepEqual(Object.keys(iconMap).sort(), [...ids].sort());

  const filename = (id) => path.basename(iconMap[id]);
  for (const id of ids.filter((value) => value.startsWith('bows/'))) {
    assert.equal(filename(id), 'delapouite-bow-arrow.svg', `${id} uses a bow silhouette`);
  }
  for (const id of ids.filter((value) => value.startsWith('crossbows/'))) {
    assert.equal(filename(id), 'carl-olsen-crossbow.svg', `${id} uses a crossbow silhouette`);
  }
  for (const id of ['bludgeons/bo-staff', 'bludgeons/quarterstaff']) {
    assert.equal(filename(id), 'lorc-wizard-staff.svg', `${id} uses a staff silhouette`);
  }
  for (const id of ['hammers-picks/light-hammer', 'hammers-picks/war-hammer', 'hammers-picks/war-mallet', 'hammers-picks/maul']) {
    assert.equal(filename(id), 'delapouite-warhammer.svg', `${id} uses a hammer silhouette`);
  }
  for (const id of ids.filter((value) => value.startsWith('armor/'))) {
    assert.match(filename(id), /(?:armor-vest|layered-armor|breastplate)\.svg$/, `${id} uses armor art`);
  }
  for (const id of ids.filter((value) => /^(?:rifle|pistol)\//.test(value))) {
    assert.equal(filename(id), 'lorc-supersonic-bullet.svg', `${id} uses a cartridge silhouette`);
  }
  for (const id of ids.filter((value) => value.startsWith('shotgun/'))) {
    assert.equal(filename(id), 'delapouite-shotgun-rounds.svg', `${id} uses shotgun ammunition art`);
  }
  const egregious = {
    'bows/shortbow': 'delapouite-bow-arrow.svg',
    'bows/yumi': 'delapouite-bow-arrow.svg',
    'crossbows/heavy-crossbow': 'carl-olsen-crossbow.svg',
    'crossbows/light-crossbow': 'carl-olsen-crossbow.svg',
    'crossbows/repeating-crossbow': 'carl-olsen-crossbow.svg',
    'crossbows/spinner': 'carl-olsen-crossbow.svg',
    'armor/padded': 'lorc-armor-vest.svg',
    'armor/studded': 'lorc-armor-vest.svg',
    'armor/chain-shirt': 'lorc-layered-armor.svg',
    'armor/hauberk': 'lorc-layered-armor.svg',
    'armor/splint': 'lorc-armor-vest.svg',
    'pistol/masterwork-pistol-cartridge': 'lorc-supersonic-bullet.svg',
    'bludgeons/bo-staff': 'lorc-wizard-staff.svg',
    'bludgeons/quarterstaff': 'lorc-wizard-staff.svg',
    'dueling-blades/rapier': 'lorc-broadsword.svg',
    'dueling-blades/estoc': 'lorc-broadsword.svg',
    'dueling-blades/cutlass': 'lorc-broadsword.svg',
    'dueling-blades/saber': 'lorc-broadsword.svg',
    'dueling-blades/smallsword': 'lorc-broadsword.svg',
    'axes/hook-sword': 'lorc-broadsword.svg',
    'axes/kama': 'delapouite-sickle.svg',
    'firearms/multi-purpose-launcher': 'skoll-winchester-rifle.svg',
    'firearms/revolving-carbine': 'skoll-winchester-rifle.svg',
    'hammers-picks/stiletto': 'lorc-plain-dagger.svg',
    'launch-weapons/blowgun': 'delapouite-dart.svg',
    'launch-weapons/portable-catapult': 'skoll-siege-ram.svg',
    'polearms/war-scythe': 'delapouite-sickle.svg',
    'spears/harpoon': 'lorc-tron-arrow.svg',
    'spears/ravenbeak': 'delapouite-war-pick.svg',
  };
  for (const [id, expected] of Object.entries(egregious)) {
    assert.equal(filename(id), expected, `${id} is not an unrelated fuzzy match`);
  }

  const credits = fs.readFileSync(path.join(root, 'ICON_ATTRIBUTION.md'), 'utf8');
  const referenced = new Set();
  for (const mappedPath of Object.values(iconMap)) {
    assert.match(mappedPath, /^modules\/foundry-rme\/assets\/icons\/[a-z0-9-]+\.svg$/);
    const file = path.basename(mappedPath);
    referenced.add(file);
    const svgPath = path.join(root, 'assets/icons', file);
    assert.ok(fs.existsSync(svgPath), `${file} exists`);
    assert.match(credits, new RegExp(`\\x60${file}\\x60`));
    const svg = fs.readFileSync(svgPath, 'utf8');
    assert.match(svg, /^<svg\s[^>]*xmlns="http:\/\/www\.w3\.org\/2000\/svg"/);
    assert.match(svg.slice(0, 300), /viewBox="[^"]+"/);
    assert.doesNotMatch(svg, /<(?:script|foreignObject)\b|(?:href|src)\s*=\s*["'](?:https?:|\/\/|data:)/i);
    const identifiers = [...svg.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]);
    assert.equal(new Set(identifiers).size, identifiers.length, `${file} has unique IDs`);
    assert.doesNotMatch(svg, /url\(\s*["']?(?:https?:|\/\/|data:)/i);
  }
  assert.equal(referenced.size, fs.readdirSync(path.join(root, 'assets/icons')).filter((f) => f.endsWith('.svg')).length);
  assert.match(credits, /82d948812bfe3f269ef8f731dcdb07b08160edc4/);
  assert.match(credits, /unmodified/i);
  assert.match(credits, /creativecommons\.org\/licenses\/by\/3\.0/);
  const totalBytes = [...referenced].reduce((sum, file) => sum + fs.statSync(path.join(root, 'assets/icons', file)).size, 0);
  assert.ok(totalBytes < 4 * 1024 * 1024, `bundle is ${totalBytes} bytes`);
});

test('src/icon-map.mjs ICON_MAP matches data/icon-map.json exactly', () => {
  assert.deepEqual(ICON_MAP, iconMap);
  const allIds = [...catalog.equipment, ...ammunition.ammunition].map(({ id }) => id);
  assert.equal(Object.keys(ICON_MAP).length, 198);
  assert.equal(Object.keys(ICON_MAP).length, allIds.length);
  assert.deepEqual(Object.keys(ICON_MAP).sort(), [...allIds].sort());
});
