import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { renderRmeItemDetails } from '../src/item-sheet.mjs';

const catalog = JSON.parse(await readFile(new URL('../data/catalog.json', import.meta.url)));
const rifle = catalog.equipment.find((entry) => entry.id === 'firearms/bolt-action-rifle');

function makeProfile() {
  const summary = { insertAdjacentHTML() {} };
  const profile = {
    open: false,
    summary,
    badge: null,
    querySelector(selector) {
      if (selector === '.rme-item-active') return profile.badge;
      if (selector === 'summary') return profile.summary;
      return null;
    },
  };
  return profile;
}
class MockPanel {
  dataset = {};
  events = {};
  innerHTML = '';
  children = [];
  querySelector(selector) {
    if (selector === '[data-rme-error]') return this.error ||= { hidden: true, textContent: '', addEventListener: (name, fn) => { this.events[name] = fn; } };
    if (selector === '[data-rme-tier]') return this.tier ||= { textContent: '', addEventListener: (name, fn) => { this.events[name] = fn; } };
    if (selector === '[data-rme-preview]') return this.preview ||= { value: '', addEventListener: (name, fn) => { this.events.preview = fn; } };
    if (selector === '[data-rme-training]') return this.training ||= { value: '', addEventListener: (name, fn) => { this.events.training = fn; } };
    if (selector === '[data-rme-perk-status]') return this.perkStatus ||= { textContent: '' };
    return null;
  }
  querySelectorAll(selector) {
    if (selector === '.rme-item-profile') return (this.profiles ||= [makeProfile(), makeProfile(), makeProfile()]);
    return [];
  }
  addEventListener(name, fn) { this.events[name] = fn; }
}
class MockDetails {
  panels = [];
  querySelector(selector) { return selector === '[data-rme-item-panel]' ? this.panels[0] || null : null; }
  append(panel) { this.panels.push(panel); }
}
function fixture(item) {
  const details = new MockDetails();
  const element = { querySelector: (selector) => selector === 'section[data-tab="details"]' ? details : null };
  const panel = new MockPanel();
  globalThis.document = { createElement: () => panel };
  return { app: { document: item }, element, details, panel };
}

test('renders escaped source and all three bolt rifle profiles once', async () => {
  const entry = { ...rifle, expertPerk: '<script>alert("x")</script>' };
  const f = fixture({ flags: { 'foundry-rme': { catalogId: entry.id } }, system: {} });
  assert.equal(await renderRmeItemDetails(f.app, f.element, { equipment: [entry] }), true);
  assert.match(f.panel.innerHTML, /RME Equipment/);
  assert.match(f.panel.innerHTML, /Awkward/);
  assert.match(f.panel.innerHTML, /&lt;script&gt;/, 'script characters are escaped in markup');
  assert.doesNotMatch(f.panel.innerHTML, /<script>alert/);
  assert.match(f.panel.innerHTML, /Expert Perk/);
  assert.equal((f.panel.innerHTML.match(/Active profile/g) || []).length, 1);
  assert.equal(await renderRmeItemDetails(f.app, f.element, { equipment: [entry] }), false);
});

test('owned actor override writes item flag and syncs catalog item', async () => {
  const state = {};
  const item = { _id: 'rifle', flags: { 'foundry-rme': { catalogId: rifle.id } }, system: { equipped: true, properties: [], damage: { base: {} }, proficient: false } };
  const actor = {
    documentName: 'Actor', isOwner: true, items: [item], system: { details: {} },
    getFlag(scope, key) { return state[scope]?.[key]; },
    async setFlag(scope, key, value) { (state[scope] ||= {})[key] = value; },
    async unsetFlag(scope, key) { delete state[scope]?.[key]; },
    async updateEmbeddedDocuments() { return []; },
  };
  item.parent = actor;
  const f = fixture(item);
  await renderRmeItemDetails(f.app, f.element, catalog);
  f.panel.training.value = 'expert';
  await f.panel.events.training({ currentTarget: f.panel.training });
  assert.equal(state['foundry-rme'].training.items[rifle.id], 'expert');
  assert.equal(f.panel.tier.textContent, 'Expert (Mastery)');
});

test('world item preview changes display only', async () => {
  const f = fixture({ flags: { 'foundry-rme': { catalogId: rifle.id } }, system: {} });
  await renderRmeItemDetails(f.app, f.element, catalog);
  f.panel.preview.value = 'expert';
  f.panel.events.preview({ currentTarget: f.panel.preview });
  assert.equal(f.panel.tier.textContent, 'Expert (Mastery)');
  assert.equal(f.panel.events.preview instanceof Function, true);
  assert.equal(f.details.panels.length, 1);
});

test('actor item with derived expert shows Inherit as the only selected option while the Expert profile badge is active', async () => {
  const choicesFlag = {
    'feat-firearms-expert': {
      items: [
        'firearms/bolt-action-rifle',
        'firearms/break-action-revolver',
        'firearms/double-barrelled-shotgun',
        'firearms/hand-cannon',
      ],
    },
  };
  const feat = { _id: 'feat-firearms-expert', type: 'feat', name: 'Firearms Expert', system: {} };
  const item = { _id: 'rifle', flags: { 'foundry-rme': { catalogId: rifle.id } }, system: {} };
  const actor = {
    documentName: 'Actor', isOwner: true, items: [item, feat], system: { details: {} },
    getFlag(scope, key) {
      if (scope === 'foundry-rme' && key === 'choices') return choicesFlag;
      return undefined;
    },
    async setFlag() {}, async unsetFlag() {}, async updateEmbeddedDocuments() { return []; },
  };
  item.parent = actor;
  const f = fixture(item);
  assert.equal(await renderRmeItemDetails(f.app, f.element, catalog), true);
  assert.match(f.panel.innerHTML, /data-rme-tier>Expert \(Mastery\)<\/span>/);
  assert.equal((f.panel.innerHTML.match(/<option[^>]*selected>/g) || []).length, 1);
  assert.match(f.panel.innerHTML, /<option value="inherit" selected>/);
  assert.doesNotMatch(f.panel.innerHTML, /<option value="expert" selected>/);
  assert.equal((f.panel.innerHTML.match(/Active profile/g) || []).length, 1);
});

test('explicit manual untrained selects exactly untrained and never Inherit', async () => {
  const item = { _id: 'rifle', flags: { 'foundry-rme': { catalogId: rifle.id } }, system: {} };
  const actor = {
    documentName: 'Actor', isOwner: true, items: [item], system: { details: {} },
    getFlag(scope, key) {
      if (scope === 'foundry-rme' && key === 'training') return { items: { [rifle.id]: 'untrained' } };
      return undefined;
    },
    async setFlag() {}, async unsetFlag() {}, async updateEmbeddedDocuments() { return []; },
  };
  item.parent = actor;
  const f = fixture(item);
  assert.equal(await renderRmeItemDetails(f.app, f.element, catalog), true);
  assert.match(f.panel.innerHTML, /data-rme-tier>Untrained<\/span>/);
  assert.equal((f.panel.innerHTML.match(/<option[^>]*selected>/g) || []).length, 1);
  assert.match(f.panel.innerHTML, /<option value="untrained" selected>/);
  assert.doesNotMatch(f.panel.innerHTML, /<option value="inherit" selected>/);
  assert.equal((f.panel.innerHTML.match(/Active profile/g) || []).length, 1);
});

test('world preview expert to basic clears the expert perk status and toggles the open profile', async () => {
  const f = fixture({ flags: { 'foundry-rme': { catalogId: rifle.id, activeTier: 'expert' } }, system: {} });
  assert.equal(await renderRmeItemDetails(f.app, f.element, catalog), true);
  assert.equal((f.panel.innerHTML.match(/Active profile/g) || []).length, 1);
  assert.match(f.panel.innerHTML, /- Active/);
  f.panel.preview.value = 'expert';
  f.panel.events.preview({ currentTarget: f.panel.preview });
  assert.equal(f.panel.perkStatus.textContent, ' - Active');
  assert.equal(f.panel.profiles[2].open, true);
  assert.equal(f.panel.profiles[1].open, false);
  f.panel.preview.value = 'proficient';
  f.panel.events.preview({ currentTarget: f.panel.preview });
  assert.equal(f.panel.tier.textContent, 'Basic (Proficient)');
  assert.equal(f.panel.perkStatus.textContent, '', 'expert perk status becomes inactive');
  assert.equal(f.panel.profiles[2].open, false, 'expert profile closes');
  assert.equal(f.panel.profiles[1].open, true, 'basic profile opens');
});

test('actor override save reflects the persisted manual selection', async () => {
  const state = {};
  const item = { _id: 'rifle', flags: { 'foundry-rme': { catalogId: rifle.id } }, system: { equipped: true, properties: [], damage: { base: {} }, proficient: false } };
  const actor = {
    documentName: 'Actor', isOwner: true, items: [item], system: { details: {} },
    getFlag(scope, key) { return state[scope]?.[key]; },
    async setFlag(scope, key, value) { (state[scope] ||= {})[key] = value; },
    async unsetFlag(scope, key) { delete state[scope]?.[key]; },
    async updateEmbeddedDocuments() { return []; },
  };
  item.parent = actor;
  const f = fixture(item);
  await renderRmeItemDetails(f.app, f.element, catalog);
  f.panel.training.value = 'expert';
  await f.panel.events.training({ currentTarget: f.panel.training });
  assert.equal(state['foundry-rme'].training.items[rifle.id], 'expert');
  assert.equal(f.panel.training.value, 'expert', 'select reflects the persisted manual selection');
  assert.equal(f.panel.tier.textContent, 'Expert (Mastery)');
});
