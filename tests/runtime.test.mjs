import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const hookRegistrations = [];
globalThis.Hooks = {
  once(name, handler) { hookRegistrations.push({ scope: 'once', name, handler }); },
  on(name, handler) { hookRegistrations.push({ scope: 'on', name, handler }); },
};

const {
  applyClassGrantSelections,
  replaceTrainingFlag,
  isProviderType,
  shouldSyncItem,
  shouldSyncItemUpdate,
  shouldSyncActorUpdate,
  hasProviderItems,
  queueActorSync,
  queueNaturalDefaultMigration,
  runNaturalDefaultMigration,
  mergeChoices,
  validateChoiceSelection,
  choiceSpecs,
} = await import('../src/main.mjs');

import { deriveActorTraining } from '../src/derive-training.mjs';

const catalog = JSON.parse(await readFile(new URL('../data/catalog.json', import.meta.url), 'utf8'));
const ammoCatalog = JSON.parse(await readFile(new URL('../data/ammunition.json', import.meta.url), 'utf8'));
const EIGHT = ['Axes', 'Bows', 'Combat Blades', 'Dueling Blades', 'Flails', 'Hammers Picks', 'Spears', 'Whips'];

// A fetch mock that routes each module catalog request to its own fixture so the
// equipment catalog and the ammunition catalog are never confused.
function makeFetchMock({ catalogData = catalog, ammoData = ammoCatalog } = {}) {
  return async (url) => {
    const path = String(url);
    if (path.includes('data/catalog.json')) return { ok: true, json: async () => catalogData };
    if (path.includes('data/ammunition.json')) return { ok: true, json: async () => ammoData };
    return { ok: false, status: 404 };
  };
}

// Run the ready-time preload so the module-level catalog and ammoCatalog populate.
// The fire-and-forget fetches settle on a tick; after this the module caches
// remain populated for the rest of the suite.
async function primeAmmoCatalogs() {
  const originalFetch = globalThis.fetch;
  const originalGame = globalThis.game;
  globalThis.fetch = makeFetchMock();
  globalThis.game = { rme: undefined };
  try {
    const ready = hookRegistrations.find((r) => r.scope === 'once' && r.name === 'ready').handler;
    ready();
    await new Promise((resolve) => setTimeout(resolve, 1));
  } finally {
    globalThis.fetch = originalFetch;
    globalThis.game = originalGame;
  }
}

test('module manifest targets Foundry 14 and dnd5e 6', async () => {
  const manifest = JSON.parse(await readFile(new URL('../module.json', import.meta.url)));
  assert.equal(manifest.id, 'foundry-rme');
  assert.equal(manifest.compatibility.minimum, '14.367');
  assert.equal(manifest.compatibility.verified, '14.368');
  assert.ok(manifest.relationships.systems.some((s) => s.id === 'dnd5e' && s.compatibility.minimum === '6.0.6'));
});

test('runtime exposes service methods and escapes catalog-facing content', async () => {
  const source = await readFile(new URL('../src/main.mjs', import.meta.url), 'utf8');
  for (const name of ['openCatalog', 'openTraining', 'importCatalog', 'syncActorItems']) assert.match(source, new RegExp(`\\b${name}\\b`));
  assert.match(source, /replace\(\/\[&<>"'\]\/g/);
  assert.match(source, /<pre class="rme-source">\$\{esc\(/);
});

test('actor render hook handles Details targets even without inventory rows', async () => {
  const source = await readFile(new URL('../src/main.mjs', import.meta.url), 'utf8');
  assert.match(source, /const hasInventory = Boolean\(element\?\.querySelector\?\.\('li\.item\[data-item-id\]'\)\)/);
  assert.match(source, /const hasDetails = Boolean\(element\?\.querySelector\?\.\('section\[data-tab="details"\] \.right'\)\)/);
  assert.match(source, /if \(hasInventory\) renderActorAmmoBadges/);
  assert.match(source, /if \(hasDetails\) renderActorRmeProficiencies/);
  assert.doesNotMatch(source, /if \(!element\?\.querySelector\?\.\('li\.item\[data-item-id\]'\)\) return/);
});

test('runtime uses v14 DialogV2 and exposes actor-sheet catalog access without a console', async () => {
  const source = await readFile(new URL('../src/main.mjs', import.meta.url), 'utf8');
  assert.match(source, /foundry\.applications\.api\.DialogV2/);
  assert.match(source, /dialog\.render\(true\)/);
  assert.match(source, /dlg\.render\(true\)/);
  assert.doesNotMatch(source, /render:\s*\(/);
  assert.match(source, /action:'rme-training',label:'RME Training',icon:/);
  assert.match(source, /action:'rme-catalog',label:'RME Catalog',icon:/);
  assert.match(source, /data-rme-import-all/);
  assert.match(source, /data-rme-import-actor/);
});

test('ammo hooks do not throw before the ready-time catalogs are loaded', () => {
  // At import the module-level catalog and ammoCatalog are both null, and the
  // `foundry` dice terms globals are absent; firing the ammo hooks in that state
  // must warn/skip and never throw (no global error on pre-ready events).
  const hook = (name) => hookRegistrations.find((r) => r.scope === 'on' && r.name === name).handler;
  const config = {};
  const message = { data: {} };
  assert.doesNotThrow(() => hook('dnd5e.preUseActivity')(null, config, config, config));
  assert.doesNotThrow(() => hook('dnd5e.activityConsumption')(null, config, config, { item: [] }));
  assert.equal(
    hook('dnd5e.postAttackRollConfiguration')([], config, config, message),
    true,
    'a pre-ready attack config allows the native roll'
  );
  assert.equal(hook('dnd5e.preRollDamage')(config, config, message), undefined, 'pre-ready damage hook silently skips');
  assert.doesNotThrow(() => hook('dnd5e.rollAttack')([], config));
  assert.doesNotThrow(() => hook('dnd5e.postRollAttack')([], config));
});

test('training dialog is source-derived and exposes source gaps and choice controls', async () => {
  const source = await readFile(new URL('../src/main.mjs', import.meta.url), 'utf8');
  assert.match(source, /computeActorTraining\(actor,data\.equipment\)/);
  assert.match(source, /data-choice-provider/);
  assert.match(source, /picture\.gaps/);
  assert.match(source, /picture\.sources/);
  assert.match(source, /data-rme-source-choices/);
  assert.match(source, /class="rme-source-grants"/);
  assert.match(source, /namesById\.get\(id\)\|\|id/);
  assert.match(source, /esc\(level\)/);
  assert.match(source, /syncActorRme\(actor,data\.equipment\)/);
  assert.doesNotMatch(source, /data-rme-apply-class|Optional starting-class training/);
  assert.match(source, /await dlg\.render\(true\);[\s\S]*?addEventListener\('input'/);
});

test('training source grants disclose named exact-tier categories and items safely', async () => {
  const source=await readFile(new URL('../src/main.mjs',import.meta.url),'utf8');
  assert.match(source, /<details class="rme-source-grants"><summary>/);
  assert.match(source, /<h4>Categories<\/h4>/);
  assert.match(source, /<h4>Items<\/h4>/);
  assert.match(source, /esc\(namesById\.get\(id\)\|\|id\)/);
  assert.match(source, /<details class="rme-training-panel" data-rme-source-choices><summary>Source choices<\/summary>/);
  assert.match(source, /data-choice-kind="\$\{kind\}"/);
});

test('training dialog uses a scrollable viewport-bounded section and responsive dimensions', async () => {
  const source = await readFile(new URL('../src/main.mjs', import.meta.url), 'utf8');
  const css = await readFile(new URL('../styles/rme.css', import.meta.url), 'utf8');
  assert.match(source, /<section class="rme-dialog rme-training">/);
  assert.match(source, /position:\{width:Math\.min\(960,window\.innerWidth-32\),height:Math\.min\(800,window\.innerHeight-32\)\}/);
  assert.match(css, /\.rme-training\s*\{[^}]*max-height:\s*min\(70vh,\s*calc\(100dvh\s*-\s*11rem\)\)[^}]*overflow-y:\s*auto/s);
  assert.match(css, /\.rme-training\s*\.rme-list\s*\{\s*max-height:\s*none;\s*overflow:\s*visible/);
});

test('training flag replacement removes old nested keys when clearing state', async () => {
  const calls = [];
  const actor = { unsetFlag: async (...args) => calls.push(['unset', ...args]), setFlag: async (...args) => calls.push(['set', ...args]) };
  await replaceTrainingFlag(actor, { groups: { Swords: 'expert' }, items: { sword: 'expert' } }, {});
  assert.deepEqual(calls, [['unset', 'foundry-rme', 'training']]);
});

test('training flag replacement supports choices and clears prior nested state', async () => {
  const calls=[]; const actor={unsetFlag:async(...args)=>calls.push(['unset',...args]),setFlag:async(...args)=>calls.push(['set',...args])};
  await replaceTrainingFlag(actor,{c1:{groups:['Axes']}},{},'choices');
  assert.deepEqual(calls,[['unset','foundry-rme','choices']]);
  calls.length=0;
  await replaceTrainingFlag(actor,{}, {groups:{Axes:'expert'}},'training');
  assert.deepEqual(calls,[['set','foundry-rme','training',{groups:{Axes:'expert'}}]]);
});

test('choice edit helpers preserve unrelated providers and allow incomplete valid choices', () => {
  const specs = [
    { sourceId: 'fighter', type: 'groups', count: 8, options: EIGHT },
    { sourceId: 'feat', type: 'choices', count: 1, options: ['axes/battle-axe', 'bows/shortbow'] },
  ];
  assert.equal(validateChoiceSelection(specs[0], EIGHT.slice(0, 4)), true);
  assert.equal(validateChoiceSelection(specs[1], []), true);
  assert.equal(validateChoiceSelection(specs[1], ['not-an-option']), false);
  const merged = mergeChoices({ unsupported: { groups: ['kept'] }, fighter: { groups: EIGHT } }, specs, {
    'fighter:groups': EIGHT.slice(0, 4), 'feat:choices': [],
  });
  assert.deepEqual(merged, { unsupported: { groups: ['kept'] }, fighter: { groups: EIGHT.slice(0, 4) } });
});

test('choice validation honors per-spec max counts for starting, multiclass and single choices', () => {
  const values = Array.from({ length: 9 }, (_, i) => `v${i}`);
  assert.equal(validateChoiceSelection({ options: values, count: 8 }, values.slice(0, 8)), true);
  assert.equal(validateChoiceSelection({ options: values, count: 4 }, values.slice(0, 4)), true);
  assert.equal(validateChoiceSelection({ options: values, count: 1 }, values.slice(0, 2)), false);
  assert.equal(validateChoiceSelection({ options: values, count: 4 }, ['v1', 'v1']), false);
  assert.equal(validateChoiceSelection({ options: values, count: 1, allowMultiple: true }, values), true);
});

test('mergeChoices persists expert-feat items to .items and category groups to .groups, and derivation resolves both without gaps', () => {
  // Expert feat (Axe expert) requires exactly 4 item choices. A completed
  // selection must persist to `.items` - the field deriveActorTraining reads -
  // and therefore preselect in the UI reads the same field.
  const featItem = { _id: 'f1', type: 'feat', name: 'Axe expert', system: { advancement: [] } };
  const featActor = makeActor({ items: [featItem] });
  const featSpecs = choiceSpecs(featActor, catalog.equipment);
  const feat = featSpecs.find((s) => s.sourceId === 'f1' && s.type === 'choices');
  assert.ok(feat, 'Axe expert feat should surface a choices spec');
  assert.equal(feat.count, 4);
  const fourItems = feat.options.slice(0, 4);
  const featMerged = mergeChoices({}, featSpecs, { 'f1:choices': fourItems });
  assert.deepEqual(featMerged.f1.items, fourItems, 'expert item selections must be stored under .items');
  const featDerived = deriveActorTraining(featActor, catalog.equipment, featMerged);
  assert.equal(featDerived.gaps.some((g) => g.sourceId === 'f1' && g.type === 'choices'), false, 'exactly 4 expert items must clear the missing-choice gap');
  for (const id of fourItems) assert.equal(featDerived.training.items[id], 'expert');

  // A multiclass category choice (fighter requires exactly 4 weapon groups)
  // must keep persisting to `.groups` and still derive group proficiencies.
  const fighterItem = { _id: 'fc', type: 'class', name: 'Fighter', system: { classIdentifier: 'fighter', advancement: [] } };
  const classActor = makeActor({ items: [fighterItem], originalClass: 'missing-original' });
  const classSpecs = choiceSpecs(classActor, catalog.equipment);
  const group = classSpecs.find((s) => s.sourceId === 'fc' && s.type === 'groups');
  assert.ok(group, 'multiclass fighter should surface a groups spec');
  assert.equal(group.count, 4);
  const fourGroups = group.options.slice(0, 4);
  const classMerged = mergeChoices({}, classSpecs, { 'fc:groups': fourGroups });
  assert.deepEqual(classMerged.fc.groups, fourGroups, 'category selections must stay under .groups');
  const classDerived = deriveActorTraining(classActor, catalog.equipment, classMerged);
  assert.equal(classDerived.gaps.some((g) => g.sourceId === 'fc' && g.type === 'groups'), false, 'exactly 4 groups must clear the multiclass gap');
  for (const g of fourGroups) assert.equal(classDerived.training.groups[g], 'proficient');
});

test('training header remains accessible for owned actors with unresolved-count label support', async () => {
  const source=await readFile(new URL('../src/main.mjs',import.meta.url),'utf8');
  assert.match(source,/action:'rme-training',label:'RME Training'/);
  assert.match(source,/getFlag\(ID,'choices'\)/);
});

test('class grants preserve expert and explicit item settings and avoid redundant group item overrides', () => {
  const entries = [{ id: 'a', group: 'Swords' }, { id: 'b', group: 'Swords' }, { id: 'c', group: 'Axes' }];
  const result = applyClassGrantSelections({ groups: { Swords: 'expert' }, items: { b: 'untrained' } }, {
    groups: { Swords: 'proficient', Axes: 'proficient' }, items: { a: 'proficient', b: 'proficient', c: 'proficient' },
  }, entries);
  assert.deepEqual(result, { groups: { Swords: 'expert', Axes: 'proficient' }, items: { b: 'untrained' } });
});

// ---------------------------------------------------------------------------
// Automatic training sync: hook registration / event filtering / scheduler
// ---------------------------------------------------------------------------

test('registers the automatic-training document hooks', () => {
  const registered = new Map();
  for (const { scope, name, handler } of hookRegistrations) {
    if (scope === 'on' && typeof handler === 'function') registered.set(name, handler);
  }
  for (const name of ['createItem', 'updateItem', 'deleteItem', 'updateActor', 'createActor']) {
    assert.equal(typeof registered.get(name), 'function', `expected a ${name} hook to be registered`);
  }
});

test('isProviderType matches only the provider item types', () => {
  for (const type of ['class', 'race', 'subclass', 'feat']) assert.equal(isProviderType(type), true);
  for (const type of ['weapon', 'equipment', 'spell', 'background']) assert.equal(isProviderType(type), false);
});

test('shouldSyncItem syncs only embedded provider or RME catalog items', () => {
  const actor = { documentName: 'Actor' };
  const embedded = (type, flags = {}) => ({ type, flags, parent: actor });
  for (const type of ['class', 'race', 'subclass', 'feat']) assert.equal(shouldSyncItem(embedded(type)), true);
  assert.equal(shouldSyncItem(embedded('weapon', { 'foundry-rme': { catalogId: 'axes/battle-axe' } })), true);
  assert.equal(shouldSyncItem(embedded('equipment', { 'foundry-rme': { catalogId: 'armor/plate' } })), true);
  // A normal embedded item with no RME marker and not a provider stays untouched.
  assert.equal(shouldSyncItem(embedded('weapon', {})), false);
  assert.equal(shouldSyncItem(embedded('equipment', {})), false);
  // A world item (no owning actor) is not an actor-embedded change.
  assert.equal(shouldSyncItem({ type: 'class', flags: {}, parent: null }), false);
  assert.equal(shouldSyncItem({ type: 'class', flags: {} }), false);
});

test('shouldSyncItemUpdate avoids feedback: only provider updates re-sync, not catalog profile writes', () => {
  const actor = { documentName: 'Actor' };
  const embedded = (type, flags = {}) => ({ type, flags, parent: actor });
  for (const type of ['class', 'race', 'subclass', 'feat']) assert.equal(shouldSyncItemUpdate(embedded(type)), true);
  // The items syncActorRme writes carry a catalogId; those must not re-trigger a sync.
  assert.equal(shouldSyncItemUpdate(embedded('weapon', { 'foundry-rme': { catalogId: 'axes/battle-axe' } })), false);
  assert.equal(shouldSyncItemUpdate({ type: 'class', flags: {}, parent: null }), false);
});

test('shouldSyncActorUpdate resyncs only on originalClass or foundry-rme training/choices changes', () => {
  assert.equal(shouldSyncActorUpdate({ flags: { 'foundry-rme': { training: { groups: { Axes: 'proficient' } } } } }), true);
  assert.equal(shouldSyncActorUpdate({ flags: { 'foundry-rme': { choices: { c1: { groups: EIGHT } } } } }), true);
  assert.equal(shouldSyncActorUpdate({ 'flags.foundry-rme.training': { groups: {} } }), true);
  assert.equal(shouldSyncActorUpdate({ 'flags.foundry-rme.choices': {} }), true);
  assert.equal(shouldSyncActorUpdate({ system: { details: { originalClass: 'fighter' } } }), true);
  assert.equal(shouldSyncActorUpdate({ 'system.details.originalClass': 'fighter' }), true);
  assert.equal(shouldSyncActorUpdate({ system: { details: { level: 2 } } }), false);
  assert.equal(shouldSyncActorUpdate({ flags: { other: {} } }), false);
  assert.equal(shouldSyncActorUpdate(null), false);
});

test('hasProviderItems selects only actors carrying class/race/subclass/feat items', () => {
  assert.equal(hasProviderItems({ items: [{ type: 'class' }] }), true);
  assert.equal(hasProviderItems({ items: [{ type: 'race' }, { type: 'feat' }] }), true);
  assert.equal(hasProviderItems({ items: [{ type: 'weapon' }, { type: 'equipment' }] }), false);
  assert.equal(hasProviderItems({ items: [] }), false);
  assert.equal(hasProviderItems(null), false);
});

// Merge an embedded-document update into the live mock item, mirroring the real
// Foundry `updateEmbeddedDocuments` behavior: both the `system` block and the
// module-owned `flags` block are merged into the existing item (each scope's
// flag object is spread onto the item's existing flags rather than replaced), so
// a mock actor actually reflects an activeTier / proficient write.
function applyItemUpdate(item, update) {
  const next = { ...item };
  if (update.system) next.system = { ...item.system, ...update.system };
  if (update.flags) {
    next.flags = { ...item.flags };
    for (const [scope, values] of Object.entries(update.flags)) {
      next.flags[scope] = { ...item.flags?.[scope], ...values };
    }
  }
  return next;
}

function makeActor({ items = [], flags = {}, originalClass = null, isOwner = true } = {}) {
  const state = {};
  for (const [scope, values] of Object.entries(flags)) state[scope] = { ...values };
  return {
    id: 'a1',
    documentName: 'Actor',
    isOwner,
    items,
    system: { details: { originalClass } },
    getFlag(scope, key) { return state[scope]?.[key]; },
    async updateEmbeddedDocuments(type, updates) {
      for (const update of updates) {
        const idx = items.findIndex((i) => i._id === update._id);
        if (idx !== -1) items[idx] = applyItemUpdate(items[idx], update);
      }
      return updates;
    },
  };
}

// Actor with a deferred first embedded-document update. The first
// updateEmbeddedDocuments call blocks until resolvePending() is invoked, so a
// test can change provider/training state while that sync is still in flight.
function makeDeferredActor() {
  const state = {};
  const items = [
    { _id: 'c1', type: 'class', name: 'Fighter', system: { classIdentifier: 'fighter', advancement: [] } },
    { _id: 'i1', type: 'weapon', name: 'Battle Axe', flags: { 'foundry-rme': { catalogId: 'axes/battle-axe' } }, system: { proficient: 0 } },
  ];
  let deferNext = true;
  let onFirstUpdateResolve;
  const applyUpdates = (updates) => {
    for (const update of updates) {
      const idx = items.findIndex((i) => i._id === update._id);
      if (idx !== -1) items[idx] = applyItemUpdate(items[idx], update);
    }
  };
  const actor = {
    id: 'a1',
    documentName: 'Actor',
    isOwner: true,
    items,
    system: { details: { originalClass: 'c1' } },
    getFlag(scope, key) { return state[scope]?.[key]; },
    setFlag(scope, key, value) { state[scope] = { ...(state[scope] || {}), [key]: value }; },
    updateCalls: 0,
    onFirstUpdate: new Promise((resolve) => { onFirstUpdateResolve = resolve; }),
    async updateEmbeddedDocuments(type, updates) {
      actor.updateCalls += 1;
      if (deferNext) {
        deferNext = false;
        onFirstUpdateResolve();
        return new Promise((resolve) => { actor.resolvePending = () => { applyUpdates(updates); resolve(updates); }; });
      }
      applyUpdates(updates);
      return updates;
    },
  };
  return actor;
}

test('scheduler coalesces per-actor triggers and applies derived training once', async () => {
  const originalQueue = globalThis.queueMicrotask;
  const originalFetch = globalThis.fetch;
  let scheduled = 0;
  globalThis.queueMicrotask = (fn) => { scheduled += 1; return originalQueue(fn); };
  globalThis.fetch = makeFetchMock();
  try {
    const classItem = { _id: 'c1', type: 'class', name: 'Fighter', system: { classIdentifier: 'fighter', advancement: [] } };
    const catalogItem = { _id: 'i1', type: 'weapon', name: 'Battle Axe', flags: { 'foundry-rme': { catalogId: 'axes/battle-axe' } }, system: { proficient: 0 } };
    const actor = makeActor({
      items: [classItem, catalogItem],
      flags: { 'foundry-rme': { choices: { c1: { groups: EIGHT } } } },
      originalClass: 'c1',
    });
    const createItem = hookRegistrations.find((r) => r.scope === 'on' && r.name === 'createItem').handler;
    // Two triggers for the same actor in one tick must schedule a single sync.
    createItem({ type: 'class', flags: {}, parent: actor });
    createItem({ type: 'class', flags: {}, parent: actor });
    assert.equal(scheduled, 1, 'two triggers in the same tick coalesce into one microtask');
    await new Promise((resolve) => setTimeout(resolve, 0));
    const updated = actor.items.find((i) => i._id === 'i1');
    assert.equal(updated.system.proficient, 1, 'the derived training was applied to the embedded catalog item');
  } finally {
    globalThis.queueMicrotask = originalQueue;
    globalThis.fetch = originalFetch;
  }
});

test('scheduler does not schedule a sync for a non-owner actor', async () => {
  const originalQueue = globalThis.queueMicrotask;
  let scheduled = 0;
  globalThis.queueMicrotask = (fn) => { scheduled += 1; return originalQueue(fn); };
  try {
    const actor = makeActor({ items: [], isOwner: false });
    assert.equal(queueActorSync(actor), false);
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(scheduled, 0);
  } finally {
    globalThis.queueMicrotask = originalQueue;
  }
});

test('queueActorSync reruns once after an in-progress sync when provider/training events arrive', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = makeFetchMock();
  try {
    const actor = makeDeferredActor();
    actor.setFlag('foundry-rme', 'choices', { c1: { groups: EIGHT } });
    assert.equal(queueActorSync(actor), true, 'the first trigger schedules a sync');
    await actor.onFirstUpdate;
    // The first sync is blocked on the deferred embedded-document update. A new
    // training state plus another trigger arriving now must not be discarded.
    actor.setFlag('foundry-rme', 'training', { items: { 'axes/battle-axe': 'untrained' } });
    assert.equal(queueActorSync(actor), true, 'a trigger during an in-progress sync is accepted');
    actor.resolvePending();
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(actor.updateCalls, 2, 'a second sync must run once the in-flight sync settles');
    assert.equal(actor.items.find((i) => i._id === 'i1').system.proficient, 0, 'the final tier reflects the latest training state');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('tagged catalog item writes do not re-arm the scheduler, so a sync terminates', async () => {
  const originalQueue = globalThis.queueMicrotask;
  const originalFetch = globalThis.fetch;
  let scheduled = 0;
  globalThis.queueMicrotask = (fn) => { scheduled += 1; return originalQueue(fn); };
  globalThis.fetch = makeFetchMock();
  try {
    const classItem = { _id: 'c1', type: 'class', name: 'Fighter', system: { classIdentifier: 'fighter', advancement: [] } };
    const taggedItem = { _id: 'i1', type: 'weapon', name: 'Battle Axe', flags: { 'foundry-rme': { catalogId: 'axes/battle-axe' } }, system: { proficient: 0 } };
    const actor = makeActor({ items: [classItem, taggedItem], flags: { 'foundry-rme': { choices: { c1: { groups: EIGHT } } } }, originalClass: 'c1' });
    const updateItem = hookRegistrations.find((r) => r.scope === 'on' && r.name === 'updateItem').handler;

    // The item the sync writes to is a tagged RME catalog item; the real runtime
    // fires updateItem for it, and without a filter that would re-arm the sync.
    updateItem({ ...taggedItem, parent: actor });
    assert.equal(scheduled, 0, 'a tagged catalog item update must not re-arm the queue');

    // A provider update is a legitimate trigger; running it once must apply
    // idempotently rather than cascade forever.
    updateItem({ ...classItem, parent: actor });
    assert.equal(scheduled, 1, 'a provider update schedules exactly one sync');
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(actor.items.find((i) => i._id === 'i1').system.proficient, 1, 'the sync applied the derived training once');
    assert.equal(scheduled, 1, 'the sync must not re-arm itself after applying (no feedback loop)');
  } finally {
    globalThis.queueMicrotask = originalQueue;
    globalThis.fetch = originalFetch;
  }
});

// ---------------------------------------------------------------------------
// Render-hook legacy natural fallback migration
// ---------------------------------------------------------------------------

const renderApp = (name) => hookRegistrations.find((r) => r.scope === 'on' && r.name === name).handler;

// A natural-weapons catalog Item synced under the old implicit Proficient
// fallback: catalogId in the natural prefix, activeTier 'proficient', native
// proficiency 1, and no grant/override, so the effective state is Untrained.
function legacyNaturalItem() {
  return {
    _id: 'n1',
    type: 'weapon',
    name: 'Bite',
    flags: { 'foundry-rme': { catalogId: 'natural-weapons/bite', activeTier: 'proficient' } },
    system: { proficient: 1 },
  };
}

test('actor render hook re-syncs a legacy natural item to untrained even without details or inventory targets', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = makeFetchMock();
  try {
    const actor = makeActor({ items: [legacyNaturalItem()] });
    const element = { querySelector: () => null };
    renderApp('renderApplicationV2')({ document: actor }, element);
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(actor.items.find((i) => i._id === 'n1').system.proficient, 0, 'the legacy natural item was re-synced to untrained');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('actor render hook does not fetch for an ordinary actor with no candidate and no render targets', async () => {
  const originalFetch = globalThis.fetch;
  let fetchCalls = 0;
  globalThis.fetch = async (url) => { fetchCalls += 1; return makeFetchMock()(url); };
  try {
    const actor = makeActor({ items: [] });
    const element = { querySelector: () => null };
    renderApp('renderApplicationV2')({ document: actor }, element);
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(fetchCalls, 0, 'an ordinary actor with no candidate or render target does not fetch the catalog');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('actor render hook does not re-queue a sync on a repeated render after the migration', async () => {
  const originalFetch = globalThis.fetch;
  const originalQueue = globalThis.queueMicrotask;
  let scheduled = 0;
  globalThis.queueMicrotask = (fn) => { scheduled += 1; return originalQueue(fn); };
  globalThis.fetch = makeFetchMock();
  try {
    const actor = makeActor({ items: [legacyNaturalItem()] });
    const element = { querySelector: () => null };
    renderApp('renderApplicationV2')({ document: actor }, element);
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(scheduled, 1, 'the first render schedules exactly one sync');
    assert.equal(actor.items.find((i) => i._id === 'n1').system.proficient, 0);
    renderApp('renderApplicationV2')({ document: actor }, element);
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(scheduled, 1, 'a repeated render after the migration does not schedule another sync');
  } finally {
    globalThis.queueMicrotask = originalQueue;
    globalThis.fetch = originalFetch;
  }
});

test('actor render hook coalesces a second render while the first sync is in flight', async () => {
  const originalFetch = globalThis.fetch;
  const originalQueue = globalThis.queueMicrotask;
  let scheduled = 0;
  globalThis.queueMicrotask = (fn) => { scheduled += 1; return originalQueue(fn); };
  globalThis.fetch = makeFetchMock();
  try {
    const actor = makeActor({ items: [legacyNaturalItem()] });
    const element = { querySelector: () => null };
    // Two renders in the same tick both match the legacy candidate, but the
    // per-actor coalescing queue must schedule only one sync microtask.
    renderApp('renderApplicationV2')({ document: actor }, element);
    renderApp('renderApplicationV2')({ document: actor }, element);
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(scheduled, 1, 'two candidate renders in one tick coalesce into one sync microtask');
  } finally {
    globalThis.queueMicrotask = originalQueue;
    globalThis.fetch = originalFetch;
  }
});

function makeDeferredNaturalActor() {
  const state = {};
  const items = [legacyNaturalItem()];
  let deferNext = true;
  let onFirstUpdateResolve;
  const applyUpdates = (updates) => {
    for (const update of updates) {
      const idx = items.findIndex((i) => i._id === update._id);
      if (idx !== -1) items[idx] = applyItemUpdate(items[idx], update);
    }
  };
  const actor = {
    id: 'a1',
    documentName: 'Actor',
    isOwner: true,
    items,
    system: { details: { originalClass: null } },
    getFlag(scope, key) { return state[scope]?.[key]; },
    setFlag(scope, key, value) { state[scope] = { ...(state[scope] || {}), [key]: value }; },
    updateCalls: 0,
    onFirstUpdate: new Promise((resolve) => { onFirstUpdateResolve = resolve; }),
    async updateEmbeddedDocuments(type, updates) {
      actor.updateCalls += 1;
      if (deferNext) {
        deferNext = false;
        onFirstUpdateResolve();
        return new Promise((resolve) => { actor.resolvePending = () => { applyUpdates(updates); resolve(updates); }; });
      }
      applyUpdates(updates);
      return updates;
    },
  };
  return actor;
}

// Deferred natural actor whose first embedded-document write is deferred but
// does NOT mutate the live items when it resolves, so a natural candidate stays
// eligible for migration after the full sync settles. This is used to verify the
// ownership recheck between the full sync and the migration: with ownership
// lost, the migration - which would otherwise still write - is skipped.
function makeDeferredNaturalActorNoApply() {
  const state = {};
  const items = [legacyNaturalItem()];
  let deferNext = true;
  let onFirstUpdateResolve;
  const applyUpdates = (updates) => {
    for (const update of updates) {
      const idx = items.findIndex((i) => i._id === update._id);
      if (idx !== -1) items[idx] = applyItemUpdate(items[idx], update);
    }
  };
  const actor = {
    id: 'a1',
    documentName: 'Actor',
    isOwner: true,
    items,
    system: { details: { originalClass: null } },
    getFlag(scope, key) { return state[scope]?.[key]; },
    setFlag(scope, key, value) { state[scope] = { ...(state[scope] || {}), [key]: value }; },
    updateCalls: 0,
    onFirstUpdate: new Promise((resolve) => { onFirstUpdateResolve = resolve; }),
    async updateEmbeddedDocuments(type, updates) {
      actor.updateCalls += 1;
      if (deferNext) {
        deferNext = false;
        onFirstUpdateResolve();
        return new Promise((resolve) => { actor.resolvePending = () => { resolve(updates); }; });
      }
      applyUpdates(updates);
      return updates;
    },
  };
  return actor;
}

test('actor render hook rechecks effective training when a grant arrives during the in-flight sync', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = makeFetchMock();
  try {
    const actor = makeDeferredNaturalActor();
    const element = { querySelector: () => null };
    renderApp('renderApplicationV2')({ document: actor }, element);
    await actor.onFirstUpdate;
    // The first sync is blocked on the deferred embedded-document update. While
    // it is in flight, a manual proficient override arrives; the queue marks the
    // actor dirty and reruns, recomputing effective training at run time, so the
    // explicit grant wins over the stale untrained write.
    actor.setFlag('foundry-rme', 'training', { items: { 'natural-weapons/bite': 'proficient' } });
    queueActorSync(actor);
    actor.resolvePending();
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(actor.items.find((i) => i._id === 'n1').system.proficient, 1, 'the final effective level (proficient) wins over the stale untrained write');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('actor render hook rechecks eligibility right before writing when proficiency is changed while the migration is queued', async () => {
  const originalFetch = globalThis.fetch;
  const originalQueue = globalThis.queueMicrotask;
  const pending = [];
  globalThis.queueMicrotask = (fn) => { pending.push(fn); };
  globalThis.fetch = makeFetchMock();
  try {
    const item = legacyNaturalItem();
    const actor = makeActor({ items: [item] });
    let updateCalls = 0;
    const baseUpdate = actor.updateEmbeddedDocuments.bind(actor);
    actor.updateEmbeddedDocuments = async (type, updates) => { updateCalls += 1; return baseUpdate(type, updates); };
    const element = { querySelector: () => null };
    renderApp('renderApplicationV2')({ document: actor }, element);
    // Let the catalog fetch settle so the render .then queues the migration.
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.ok(pending.length >= 1, 'the render must have queued a migration microtask');
    // The user changes the native proficiency to 0 after the migration was queued
    // but before its microtask runs; the migration must recheck and write nothing.
    item.system.proficient = 0;
    const queued = pending.splice(0);
    for (const fn of queued) originalQueue(fn);
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(updateCalls, 0, 'a stale natural item whose proficiency was changed to 0 is never rewritten');
    assert.equal(actor.items.find((i) => i._id === 'n1').system.proficient, 0);
  } finally {
    globalThis.queueMicrotask = originalQueue;
    globalThis.fetch = originalFetch;
  }
});

test('runNaturalDefaultMigration patches only the qualifying legacy natural item and leaves other catalog items alone', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = makeFetchMock();
  try {
    const classItem = { _id: 'c1', type: 'class', name: 'Fighter', system: { classIdentifier: 'fighter', advancement: [] } };
    const axeItem = { _id: 'i1', type: 'weapon', name: 'Battle Axe', flags: { 'foundry-rme': { catalogId: 'axes/battle-axe' } }, system: { proficient: 0 } };
    const naturalItem = { _id: 'n1', type: 'weapon', name: 'Bite', flags: { 'foundry-rme': { catalogId: 'natural-weapons/bite', activeTier: 'proficient' } }, system: { proficient: 1 } };
    const actor = makeActor({
      items: [classItem, axeItem, naturalItem],
      flags: { 'foundry-rme': { choices: { c1: { groups: EIGHT } } } },
      originalClass: 'c1',
    });
    const updates = await runNaturalDefaultMigration(actor);
    // Only the eligible natural item is patched; the axe is not part of the
    // migration's equipment and is left untouched.
    assert.equal(updates.length, 1);
    assert.equal(updates[0]._id, 'n1');
    assert.equal(updates[0].system.proficient, 0);
    assert.equal(actor.items.find((i) => i._id === 'n1').system.proficient, 0);
    assert.equal(actor.items.find((i) => i._id === 'n1').flags['foundry-rme'].activeTier, 'untrained');
    assert.equal(actor.items.find((i) => i._id === 'i1').system.proficient, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('simultaneous full and migration requests are both processed, in either order, with no request discarded', async () => {
  const originalFetch = globalThis.fetch;
  const originalQueue = globalThis.queueMicrotask;
  let scheduled = 0;
  globalThis.queueMicrotask = (fn) => { scheduled += 1; return originalQueue(fn); };
  globalThis.fetch = makeFetchMock();
  try {
    for (const [label, firstQueue, secondQueue] of [
      ['full then migration', queueActorSync, queueNaturalDefaultMigration],
      ['migration then full', queueNaturalDefaultMigration, queueActorSync],
    ]) {
      const classItem = { _id: 'c1', type: 'class', name: 'Fighter', system: { classIdentifier: 'fighter', advancement: [] } };
      const axeItem = { _id: 'i1', type: 'weapon', name: 'Battle Axe', flags: { 'foundry-rme': { catalogId: 'axes/battle-axe' } }, system: { proficient: 0 } };
      const naturalItem = { _id: 'n1', type: 'weapon', name: 'Bite', flags: { 'foundry-rme': { catalogId: 'natural-weapons/bite', activeTier: 'proficient' } }, system: { proficient: 1 } };
      const actor = makeActor({
        items: [classItem, axeItem, naturalItem],
        flags: { 'foundry-rme': { choices: { c1: { groups: EIGHT } } } },
        originalClass: 'c1',
      });
      let updateCalls = 0;
      const baseUpdate = actor.updateEmbeddedDocuments.bind(actor);
      actor.updateEmbeddedDocuments = async (type, updates) => { updateCalls += 1; return baseUpdate(type, updates); };
      scheduled = 0;
      assert.equal(firstQueue(actor), true, `${label}: the first request is accepted`);
      assert.equal(secondQueue(actor), true, `${label}: the second request is accepted`);
      await new Promise((resolve) => setTimeout(resolve, 0));
      assert.equal(scheduled, 1, `${label}: both requests coalesce into one microtask`);
      // Full sync derives the axe to proficient and corrects the natural; migration
      // rechecks and writes nothing further. Neither request was dropped.
      assert.equal(actor.items.find((i) => i._id === 'i1').system.proficient, 1, `${label}: the full sync was processed`);
      assert.equal(actor.items.find((i) => i._id === 'n1').system.proficient, 0, `${label}: the legacy natural was corrected (no discarded request)`);
      assert.ok(updateCalls >= 1, `${label}: at least the full sync batch was written`);
    }
  } finally {
    globalThis.queueMicrotask = originalQueue;
    globalThis.fetch = originalFetch;
  }
});

test('ownership lost during a deferred full sync skips the pending migration write', async () => {
  const originalFetch = globalThis.fetch;
  const originalQueue = globalThis.queueMicrotask;
  let scheduled = 0;
  globalThis.queueMicrotask = (fn) => { scheduled += 1; return originalQueue(fn); };
  globalThis.fetch = makeFetchMock();
  try {
    // The deferred write is not applied when it resolves, so the natural item is
    // still a candidate the migration would write were it allowed to run. A full
    // sync and a migration are queued together; while the full sync is blocked on
    // its deferred embedded-document write, the actor ceases to be owned, and the
    // migration must then be skipped so no non-owner write is issued.
    const actor = makeDeferredNaturalActorNoApply();
    assert.equal(queueActorSync(actor), true, 'the full sync is queued');
    assert.equal(queueNaturalDefaultMigration(actor), true, 'the migration is queued alongside the full sync');
    await actor.onFirstUpdate;
    assert.equal(actor.updateCalls, 1, 'only the deferred full-sync write has been issued so far');
    actor.isOwner = false;
    actor.resolvePending();
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(scheduled, 1, 'the full sync and migration coalesce into one microtask');
    assert.equal(actor.updateCalls, 1, 'the migration must not write for a non-owner');
  } finally {
    globalThis.queueMicrotask = originalQueue;
    globalThis.fetch = originalFetch;
  }
});

// ---------------------------------------------------------------------------
// Init-time dnd5e config registration
// ---------------------------------------------------------------------------

test('init hook registers RME weapon types and properties without disturbing native dnd5e entries', () => {
  const originalConfig = globalThis.CONFIG;
  const nativeWeaponTypes = { simpleM: 'DND5E.WeaponSimpleM', natural: 'DND5E.WeaponNatural' };
  const nativeWeaponTypeMap = { simpleM: 'melee', natural: 'natural' };
  const nativeItemProperties = {
    fin: { label: 'DND5E.ITEM.Property.Finesse' },
    fir: { label: 'DND5E.ITEM.Property.Firearm' },
  };
  const nativeValid = new Set(['fin', 'fir', 'rch']);
  globalThis.CONFIG = {
    DND5E: {
      weaponTypes: { ...nativeWeaponTypes },
      weaponTypeMap: { ...nativeWeaponTypeMap },
      weaponProficienciesMap: { simpleM: 'sim' },
      itemProperties: { ...nativeItemProperties },
      validProperties: { weapon: new Set(nativeValid) },
    },
  };
  try {
    const init = hookRegistrations.find((r) => r.name === 'init').handler;
    assert.doesNotThrow(() => init());
    const config = globalThis.CONFIG.DND5E;
    assert.equal(config.weaponTypes.rmeFirearms, 'RME: Firearms', 'rmeFirearms weapon type registered');
    assert.ok(config.validProperties.weapon.has('rme-awkward'), 'rme-awkward is a valid weapon property');
    // Native dnd5e entries are left exactly as they were.
    assert.equal(config.weaponTypes.simpleM, 'DND5E.WeaponSimpleM');
    assert.equal(config.weaponTypes.natural, 'DND5E.WeaponNatural');
    assert.equal(config.weaponTypeMap.simpleM, 'melee');
    assert.equal(config.weaponTypeMap.natural, 'natural');
    assert.deepEqual(config.itemProperties.fin, { label: 'DND5E.ITEM.Property.Finesse' });
    assert.deepEqual(config.itemProperties.fir, { label: 'DND5E.ITEM.Property.Firearm' });
    assert.equal(config.weaponProficienciesMap.simpleM, 'sim');
    for (const key of nativeValid) assert.ok(config.validProperties.weapon.has(key), `native weapon property ${key} preserved`);
    // RME weapon types never claim a native simple/martial proficiency.
    assert.equal(config.weaponProficienciesMap.rmeFirearms, undefined);
  } finally {
    globalThis.CONFIG = originalConfig;
  }
});

test('init hook logs a warning and does not throw when CONFIG.DND5E is missing', () => {
  const originalConfig = globalThis.CONFIG;
  const originalWarn = console.warn;
  const warnings = [];
  console.warn = (...args) => { warnings.push(args.join(' ')); };
  globalThis.CONFIG = {};
  try {
    const init = hookRegistrations.find((r) => r.name === 'init').handler;
    assert.doesNotThrow(() => init());
    assert.ok(warnings.some((w) => w.includes('CONFIG.DND5E')), 'warning should mention the missing CONFIG.DND5E');
  } finally {
    console.warn = originalWarn;
    globalThis.CONFIG = originalConfig;
  }
});

// ---------------------------------------------------------------------------
// Module-managed ammunition
// ---------------------------------------------------------------------------

test('registers the module-managed ammunition hooks', () => {
  const registered = new Map();
  for (const { scope, name, handler } of hookRegistrations) {
    if (scope === 'on' && typeof handler === 'function') registered.set(name, handler);
  }
  for (const name of [
    'dnd5e.preUseActivity',
    'dnd5e.activityConsumption',
    'dnd5e.postAttackRollConfiguration',
    'dnd5e.rollAttack',
    'dnd5e.postRollAttack',
    'dnd5e.preRollDamage',
  ]) {
    assert.equal(typeof registered.get(name), 'function', `expected a ${name} hook to be registered`);
  }
});

test('ready handler exposes the game.rme ammunition API and preserves existing methods', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = makeFetchMock();
  const originalGame = globalThis.game;
  globalThis.game = { rme: undefined };
  try {
    const ready = hookRegistrations.find((r) => r.scope === 'once' && r.name === 'ready').handler;
    ready();
    for (const name of ['assignAmmo', 'reloadAmmo', 'getAmmoState', 'getAmmoEffect']) {
      assert.equal(typeof globalThis.game.rme[name], 'function', `expected game.rme.${name} to be a function`);
    }
    for (const name of ['openCatalog', 'openTraining', 'importCatalog', 'syncActorItems', 'getTraining', 'syncActor']) {
      assert.equal(typeof globalThis.game.rme[name], 'function', `existing service method ${name} must be preserved`);
    }
    // Give the fire-and-forget catalog preload a tick to settle without throwing.
    await new Promise((resolve) => setTimeout(resolve, 0));
    const effect = await globalThis.game.rme.getAmmoEffect('arrow/plus-1-arrows');
    assert.equal(effect?.attackBonus, 1, 'getAmmoEffect returns the approved +1 effect descriptor');
    assert.equal(effect?.damageBonus, 1, 'getAmmoEffect returns the approved +1 damage descriptor');
  } finally {
    globalThis.game = originalGame;
    globalThis.fetch = originalFetch;
  }
});

// ---------------------------------------------------------------------------
// Ammo-roll wiring (bonus / damage application)
// ---------------------------------------------------------------------------

// A tagged, module-managed bow weapon on an owned actor, optionally carrying a
// compatible +1 arrow reserve stack. The weapon id 'bows/compound-bow' is an
// RME Bows entry (ammoFamily 'arrow', capacity 0 / direct consumption).
function makeSupportedBowActor({ withAmmo = false, ammoId = 'arrow/plus-1-arrows', quantity = 20 } = {}) {
  const weapon = {
    _id: 'w1',
    type: 'weapon',
    name: 'Compound Bow',
    flags: {
      'foundry-rme': {
        catalogId: 'bows/compound-bow',
        ammunition: { reserveItemId: withAmmo ? 'ammo1' : null, loaded: 0, loadedAmmoId: null },
      },
    },
  };
  const items = [weapon];
  if (withAmmo) {
    items.push({
      _id: 'ammo1',
      type: 'consumable',
      name: '+1 Arrows',
      flags: { 'foundry-rme': { ammoId, family: 'arrow' } },
      system: { quantity },
    });
  }
  const actor = makeActor({ items, originalClass: null });
  const activity = { type: 'attack', actor, item: weapon };
  const config = { subject: activity, attackMode: 'ranged' };
  return { actor, weapon, activity, config };
}

const ammoHook = (name) => hookRegistrations.find((r) => r.scope === 'on' && r.name === name).handler;

test('postAttackRollConfiguration blocks without bonus when the ammo gate fails', async () => {
  await primeAmmoCatalogs();
  const { config } = makeSupportedBowActor({ withAmmo: false });
  const rolls = [{ terms: [{ kind: 'base' }], evaluated: false, options: { attackMode: 'ranged' } }];
  const result = ammoHook('dnd5e.postAttackRollConfiguration')(rolls, config, {}, { data: {} });
  assert.equal(result, false, 'a shot with no valid ammo blocks the roll');
  assert.equal(rolls[0].terms.length, 1, 'no +1 bonus is applied when the roll is blocked');
  assert.equal(rolls[0].options.rmeAmmoApplied, undefined, 'the blocked roll is not marked as ammo-applied');
});

test('postAttackRollConfiguration applies the +1 attack bonus and provenance when ammo is available', async () => {
  await primeAmmoCatalogs();
  const originalFoundry = globalThis.foundry;
  const terms = [];
  class OperatorTerm {
    constructor(arg) { this.kind = 'operator'; this.operator = arg.operator; terms.push(['operator', arg.operator]); }
  }
  class NumericTerm {
    constructor(arg) { this.kind = 'number'; this.number = arg.number; this.options = arg.options; terms.push(['number', arg.number]); }
  }
  globalThis.foundry = { dice: { terms: { OperatorTerm, NumericTerm } } };
  try {
    const { config } = makeSupportedBowActor({ withAmmo: true });
    const rolls = [{ terms: [{ kind: 'base' }], evaluated: false, options: { attackMode: 'ranged' }, resetFormula() {} }];
    const message = { data: {} };
    const result = ammoHook('dnd5e.postAttackRollConfiguration')(rolls, config, {}, message);
    assert.equal(result, true, 'an available shot is allowed');
    assert.deepEqual(terms, [['operator', '+'], ['number', 1]], 'the +1 operator and numeric terms are appended');
    assert.equal(rolls[0].options.rmeAmmoApplied, true, 'the roll is marked to avoid a duplicate application');
    assert.equal(rolls[0].terms.length, 3, 'the base term is preserved and two bonus terms are appended');
    const flags = message.data.flags['foundry-rme'];
    assert.equal(flags.ammoId, 'arrow/plus-1-arrows', 'chat provenance carries the ammo id');
    assert.equal(flags.ammoEffectText, 'Grants a +1 bonus to attack and damage rolls.', 'chat provenance carries the effect text');
  } finally {
    globalThis.foundry = originalFoundry;
  }
});

test('preRollDamage applies approved damage additions and chat provenance', async () => {
  await primeAmmoCatalogs();
  const { activity } = makeSupportedBowActor({ withAmmo: true });
  const config = {
    subject: activity,
    rolls: [{ parts: ['1d8'] }],
    ammunition: { flags: { 'foundry-rme': { ammoId: 'arrow/plus-1-arrows' } } },
  };
  const message = { data: {} };
  ammoHook('dnd5e.preRollDamage')(config, {}, message);
  assert.deepEqual(config.rolls[0].parts, ['1d8', '1'], 'the flat +1 damage bonus is appended as a plain numeric part');
  assert.equal(config.rmeAmmoDamageApplied, true, 'the config is marked applied');
  assert.equal(message.data.flags['foundry-rme'].ammoId, 'arrow/plus-1-arrows', 'chat provenance carries the ammo id');
});

test('preRollDamage does not double-apply ammo damage', async () => {
  await primeAmmoCatalogs();
  const { activity } = makeSupportedBowActor({ withAmmo: true });
  const config = {
    subject: activity,
    rolls: [{ parts: ['1d8'] }],
    ammunition: { flags: { 'foundry-rme': { ammoId: 'arrow/plus-1-arrows' } } },
  };
  const hook = ammoHook('dnd5e.preRollDamage');
  hook(config, {}, { data: {} });
  hook(config, {}, { data: {} });
  assert.deepEqual(config.rolls[0].parts, ['1d8', '1'], 'the damage addition is not applied twice');
});
