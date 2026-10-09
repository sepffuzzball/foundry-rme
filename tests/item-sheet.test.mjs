import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { renderRmeItemDetails } from '../src/item-sheet.mjs';
import { spendActorShot } from '../src/ammo-runtime.mjs';

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
  _innerHTML = '';
  children = [];

  get innerHTML() { return this._innerHTML; }
  set innerHTML(value) { this._innerHTML = value; }

  querySelector(selector) {
    if (selector === '[data-rme-error]') return this.error ||= { hidden: true, textContent: '', addEventListener: (name, fn) => { this.events[name] = fn; } };
    if (selector === '[data-rme-tier]') return this.tier ||= { textContent: '', addEventListener: (name, fn) => { this.events[name] = fn; } };
    if (selector === '[data-rme-preview]') return this.preview ||= { value: '', addEventListener: (name, fn) => { this.events.preview = fn; } };
    if (selector === '[data-rme-training]') return this.training ||= { value: '', addEventListener: (name, fn) => { this.events.training = fn; } };
    if (selector === '[data-rme-perk-status]') return this.perkStatus ||= { textContent: '' };
    if (selector === '[data-rme-ammo-region]') return this._ammoRegion();
    return null;
  }
  querySelectorAll(selector) {
    if (selector === '.rme-item-profile') return (this.profiles ||= [makeProfile(), makeProfile(), makeProfile()]);
    return [];
  }
  addEventListener(name, fn) { this.events[name] = fn; }

  _ammoRegion() {
    const panel = this;
    const region = {};
    Object.defineProperty(region, 'outerHTML', {
      get: () => panel._regionMarkup(),
      set: (value) => panel._replaceRegion(value),
    });
    return region;
  }
  _regionMarkup() {
    const match = /<section[^>]*data-rme-ammo-region[^>]*>[\s\S]*?<\/section>/.exec(this._innerHTML);
    return match ? match[0] : null;
  }
  _replaceRegion(value) {
    const current = this._regionMarkup();
    if (current == null) { this._innerHTML += value; return; }
    this._innerHTML = this._innerHTML.replace(current, value);
  }
}
class MockDetails {
  panels = [];
  querySelector(selector) { return selector === '[data-rme-item-panel]' ? this.panels[0] || null : null; }
  append(panel) { this.panels.push(panel); }
  prepend(panel) { this.panels.unshift(panel); }
}
function fixture(item) {
  const details = new MockDetails();
  const element = { querySelector: (selector) => selector === 'section[data-tab="details"]' ? details : null };
  const panel = new MockPanel();
  globalThis.document = { createElement: () => panel };
  return { app: { document: item }, element, details, panel };
}

// --- Ammo integration harness -------------------------------------------------

function applyPatch(target, patch) {
  for (const [key, value] of Object.entries(patch)) {
    if (key === '_id') continue;
    if (key.startsWith('flags.')) {
      const parts = key.split('.');
      const scope = parts[1];
      const path = parts.slice(2);
      target.flags ||= {};
      target.flags[scope] ||= {};
      let obj = target.flags[scope];
      for (let i = 0; i < path.length - 1; i++) {
        obj[path[i]] ||= {};
        obj = obj[path[i]];
      }
      obj[path[path.length - 1]] = value;
    } else {
      target[key] = value;
    }
  }
}

function ammoActor({ weapon, stacks = [], training } = {}) {
  const flags = {};
  if (training) flags.training = training;
  const items = [weapon, ...stacks];
  const actor = {
    documentName: 'Actor',
    isOwner: true,
    items,
    system: { details: {} },
    getFlag(scope, key) {
      if (scope !== 'foundry-rme') return undefined;
      return flags[key];
    },
    async setFlag(scope, key, value) {
      if (scope === 'foundry-rme') flags[key] = value;
    },
    async unsetFlag(scope, key) {
      if (scope === 'foundry-rme') delete flags[key];
    },
    async updateEmbeddedDocuments(type, patches) {
      if (type !== 'Item') return;
      for (const patch of patches || []) {
        const target = items.find((i) => (i._id ?? i.id) === patch._id);
        if (target) applyPatch(target, patch);
      }
    },
  };
  weapon.parent = actor;
  for (const stack of stacks) stack.parent = actor;
  return { actor, flags };
}

function boltWeapon() {
  return {
    _id: 'rifle',
    id: 'rifle',
    name: 'Bolt-Action Rifle',
    type: 'weapon',
    flags: { 'foundry-rme': { catalogId: 'firearms/bolt-action-rifle', ammunition: { reserveItemId: null, loaded: 0, loadedAmmoId: null } } },
    system: {},
  };
}
function cartridgeStack(name = 'Rifle Cartridge', quantity = 20, id = 'cart-1') {
  return {
    _id: id,
    id,
    name,
    type: 'consumable',
    flags: { 'foundry-rme': { family: 'rifle', ammoId: 'rifle/rifle-cartridge' } },
    system: { quantity },
  };
}
function bowWeapon() {
  const entry = catalog.equipment.find((e) => e.group === 'Bows');
  return {
    _id: 'bow',
    id: 'bow',
    name: entry.name,
    type: 'weapon',
    flags: { 'foundry-rme': { catalogId: entry.id, ammunition: { reserveItemId: null, loaded: 0, loadedAmmoId: null } } },
    system: {},
  };
}
function arrowStack(name = 'Arrows', quantity = 20) {
  return {
    _id: 'arrow-1',
    id: 'arrow-1',
    name,
    type: 'consumable',
    flags: { 'foundry-rme': { family: 'arrow', ammoId: 'arrow/arrows' } },
    system: { quantity },
  };
}
function ballistaWeapon() {
  return {
    _id: 'ballista',
    id: 'ballista',
    name: 'Portable Ballista',
    type: 'weapon',
    flags: { 'foundry-rme': { catalogId: 'crossbows/portable-ballista', ammunition: { reserveItemId: null, loaded: 0, loadedAmmoId: null } } },
    system: {},
  };
}
function javelinWeapon() {
  return {
    _id: 'javelin',
    id: 'javelin',
    name: 'Javelin',
    type: 'weapon',
    flags: {},
    system: { quantity: 5 },
  };
}
function selectTarget(value) {
  return {
    value,
    matches: (selector) => selector === '[data-rme-ammo-select]',
    closest: (selector) => selector === '[data-rme-ammo-select]' ? { value } : null,
  };
}
function reloadTarget(optionId) {
  const button = { dataset: { rmeReload: optionId } };
  return {
    closest: (selector) => selector === '[data-rme-reload]' ? button : null,
    matches: (selector) => selector === '[data-rme-reload]',
  };
}
function ammoStateOf(actor) {
  return actor.items[0].flags['foundry-rme'].ammunition;
}

test('renders escaped source and all three bolt rifle profiles once', async () => {
  const entry = { ...rifle, expertPerk: '<script>alert("x")</script>' };
  const f = fixture({ flags: { 'foundry-rme': { catalogId: entry.id } }, system: {} });
  assert.equal(await renderRmeItemDetails(f.app, f.element, { equipment: [entry] }), true);
  assert.equal(f.details.panels[0], f.panel, 'RME Equipment is first in the native Details tab');
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

test('compendium/world ammo weapon shows an import-to-actor notice instead of an empty panel', async () => {
  const f = fixture({ flags: { 'foundry-rme': { catalogId: rifle.id } }, system: {} });
  assert.equal(await renderRmeItemDetails(f.app, f.element, catalog), true);
  assert.match(f.panel.innerHTML, /data-rme-ammo-region/);
  assert.match(f.panel.innerHTML, /Import to actor to assign ammo\./);
});

test('ammo assignment selection saves the reserve stack on the actor weapon', async () => {
  const weapon = boltWeapon();
  const { actor } = ammoActor({ weapon, stacks: [cartridgeStack()] });
  const f = fixture(weapon);
  assert.equal(await renderRmeItemDetails(f.app, f.element, catalog), true);
  assert.match(f.panel.innerHTML, /Choose a reserve stack/);
  await f.panel.events.change({ target: selectTarget('cart-1') });
  assert.equal(ammoStateOf(actor).reserveItemId, 'cart-1');
  assert.match(f.panel.innerHTML, /Reserve: <strong>Rifle Cartridge<\/strong> \(20 remaining\)/);
});

test('ammo reload buttons keep operating after region replacement through panel delegation', async () => {
  const weapon = boltWeapon();
  const { actor } = ammoActor({ weapon, stacks: [cartridgeStack()] });
  const f = fixture(weapon);
  await renderRmeItemDetails(f.app, f.element, catalog);
  await f.panel.events.change({ target: selectTarget('cart-1') });
  await f.panel.events.click({ target: reloadTarget('action-full') });
  assert.equal(ammoStateOf(actor).loaded, 4);
  assert.match(f.panel.innerHTML, /Magazine: 4\/4 loaded/);
  // A second click through the freshly rendered region still reaches the runtime.
  await f.panel.events.click({ target: reloadTarget('action-full') });
  assert.equal(ammoStateOf(actor).loaded, 4);
  assert.match(f.panel.error.textContent, /Nothing to reload/);
});

test('bolt rifle full reload fills 4 and an expert single reload adds +1', async () => {
  const weapon = boltWeapon();
  const { actor } = ammoActor({ weapon, stacks: [cartridgeStack()] });
  const f = fixture(weapon);
  await renderRmeItemDetails(f.app, f.element, catalog);
  await f.panel.events.change({ target: selectTarget('cart-1') });
  await f.panel.events.click({ target: reloadTarget('action-full') });
  assert.equal(ammoStateOf(actor).loaded, 4, 'full reload fills the whole magazine');
  await spendActorShot(actor, 'rifle', catalog.equipment);
  await spendActorShot(actor, 'rifle', catalog.equipment);
  await spendActorShot(actor, 'rifle', catalog.equipment);
  assert.equal(ammoStateOf(actor).loaded, 1);
  f.panel.training.value = 'expert';
  await f.panel.events.training({ currentTarget: f.panel.training });
  await f.panel.events.click({ target: reloadTarget('special-single') });
  assert.equal(ammoStateOf(actor).loaded, 2, 'expert single cartridge reload adds exactly one round');
});

test('direct-consumption bow shows no reload buttons', async () => {
  const weapon = bowWeapon();
  const { actor } = ammoActor({ weapon, stacks: [arrowStack()] });
  const f = fixture(weapon);
  await renderRmeItemDetails(f.app, f.element, catalog);
  assert.match(f.panel.innerHTML, /Direct ammunition:/);
  assert.doesNotMatch(f.panel.innerHTML, /data-rme-reload/);
});

test('no compatible ammo shows the guidance notice and no reserve controls', async () => {
  const weapon = boltWeapon();
  const { actor } = ammoActor({ weapon });
  const f = fixture(weapon);
  await renderRmeItemDetails(f.app, f.element, catalog);
  assert.match(f.panel.innerHTML, /Import ammunition from the RME Ammunition pack\./);
  assert.doesNotMatch(f.panel.innerHTML, /data-rme-ammo-select/);
  assert.doesNotMatch(f.panel.innerHTML, /Assign ammunition on an actor\./);
});

test('Portable Ballista guidance points at an ordinary Javelin weapon item', async () => {
  const weapon = ballistaWeapon();
  const { actor } = ammoActor({ weapon });
  const f = fixture(weapon);
  await renderRmeItemDetails(f.app, f.element, catalog);
  assert.match(f.panel.innerHTML, /Add a Javelin weapon item to the actor to assign ammo\./);
  assert.doesNotMatch(f.panel.innerHTML, /Import ammunition from the RME Ammunition pack\./);
});

test('Portable Ballista with a Javelin on the actor offers the reserve select and hides guidance', async () => {
  const weapon = ballistaWeapon();
  const { actor } = ammoActor({ weapon, stacks: [javelinWeapon()] });
  const f = fixture(weapon);
  await renderRmeItemDetails(f.app, f.element, catalog);
  assert.match(f.panel.innerHTML, /data-rme-ammo-select/);
  assert.doesNotMatch(f.panel.innerHTML, /Add a Javelin weapon item to the actor to assign ammo\./);
});

test('depleted or unavailable reserve shows the placeholder selected and a warning', async () => {
  const weapon = boltWeapon();
  weapon.flags['foundry-rme'].ammunition = { reserveItemId: 'cart-1', loaded: 0, loadedAmmoId: null };
  const { actor } = ammoActor({ weapon, stacks: [cartridgeStack('Rifle Cartridge', 0, 'cart-1'), cartridgeStack('Rifle Cartridge', 20, 'cart-2')] });
  const f = fixture(weapon);
  await renderRmeItemDetails(f.app, f.element, catalog);
  assert.match(f.panel.innerHTML, /<option value="" selected>Choose a reserve stack<\/option>/);
  assert.match(f.panel.innerHTML, /Assigned reserve is depleted or unavailable\./);
});

test('loaded ammunition resolves the friendly stack name through the catalog ammoId', async () => {
  const weapon = boltWeapon();
  weapon.flags['foundry-rme'].ammunition = { reserveItemId: 'cart-1', loaded: 3, loadedAmmoId: 'rifle/rifle-cartridge' };
  const { actor } = ammoActor({ weapon, stacks: [cartridgeStack()] });
  const f = fixture(weapon);
  await renderRmeItemDetails(f.app, f.element, catalog);
  assert.match(f.panel.innerHTML, /Loaded ammunition: Rifle Cartridge/);
  assert.doesNotMatch(f.panel.innerHTML, /Loaded ammunition: rifle\/rifle-cartridge/);
});

test('loaded ammunition preserves the catalog ammo id when no matching stack remains', async () => {
  const weapon = boltWeapon();
  weapon.flags['foundry-rme'].ammunition = { reserveItemId: 'cart-1', loaded: 3, loadedAmmoId: 'rifle/rifle-cartridge' };
  const { actor } = ammoActor({ weapon, stacks: [cartridgeStack('Rifle Cartridge', 0)] });
  const f = fixture(weapon);
  await renderRmeItemDetails(f.app, f.element, catalog);
  assert.match(f.panel.innerHTML, /Loaded ammunition: rifle\/rifle-cartridge/);
  assert.match(f.panel.innerHTML, /reserve changed; loaded rounds remain/);
});

test('escaped malicious ammo stack name in the reserve and option markup', async () => {
  const weapon = boltWeapon();
  const { actor } = ammoActor({ weapon, stacks: [cartridgeStack("<script>alert('x')</script>")] });
  const f = fixture(weapon);
  await renderRmeItemDetails(f.app, f.element, catalog);
  assert.match(f.panel.innerHTML, /&lt;script&gt;alert\(&#39;x&#39;\)&lt;\/script&gt;/);
  assert.doesNotMatch(f.panel.innerHTML, /<script>alert\('x'\)<\/script>/);
});
