import { LEVELS, resolveTraining } from './training.mjs';
import { makeItemData, syncActorItems } from './items.mjs';
import { computeActorTraining, syncActorRme } from './actor-training.mjs';
import { deriveActorTraining } from './derive-training.mjs';

const ID = 'foundry-rme';
let catalog;
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' })[c]);
const notifyError = (error) => { console.error(`[${ID}]`, error); globalThis.ui?.notifications?.error(error?.message || String(error)); };
const readTraining = (actor) => actor.getFlag(ID, 'training') || {};
const options = (includeInherit = false) => `${includeInherit ? '<option value="inherit">Inherit</option>' : ''}${LEVELS.map((l) => `<option value="${l}">${l[0].toUpperCase()}${l.slice(1)}</option>`).join('')}`;

export function trainingSnapshot(groups = {}, items = {}) { const out = {}; if (Object.keys(groups).length) out.groups = { ...groups }; if (Object.keys(items).length) out.items = { ...items }; return out; }
export function applyClassGrantSelections(current, grants, equipment) {
  const groups = { ...(current.groups || {}) }, items = { ...(current.items || {}) };
  for (const [group, level] of Object.entries(grants.groups || {})) if (!groups[group]) groups[group] = level;
  const byId = new Map(equipment.map((entry) => [entry.id, entry]));
  for (const [id, level] of Object.entries(grants.items || {})) { const entry = byId.get(id); if (!entry || Object.hasOwn(items, id)) continue; if (resolveTraining(entry, trainingSnapshot(groups, items)) === 'untrained') items[id] = level; }
  return trainingSnapshot(groups, items);
}
export async function replaceTrainingFlag(actor, previous, next, key = 'training') {
  const hadPrevious = Object.keys(previous || {}).length > 0;
  if (hadPrevious) await actor.unsetFlag(ID, key);
  try { if (Object.keys(next || {}).length) await actor.setFlag(ID, key, next); }
  catch (error) { if (hadPrevious) { try { await actor.setFlag(ID, key, previous); } catch (restoreError) { console.error(`[${ID}] Failed to restore previous ${key} flag`, restoreError); } } throw error; }
}

export function choiceSpecs(actor, equipment) {
  const result = deriveActorTraining(actor, equipment, {});
  return (result.gaps || []).filter((gap) => gap.sourceId && ['groups', 'choices'].includes(gap.type)
    && Number.isFinite(Number(gap.count)) && Number(gap.count) > 0 && gap.options?.length)
    .map((gap) => ({ ...gap, count: Number(gap.count), allowMultiple: /at least/i.test(gap.reason || '') }));
}

// The derivation schema reads item-level expert/subclass selections from
// `.items` and category selections from `.groups`, while derive reports the
// former as gap `type` 'choices'. The UI and mergeChoices must persist to the
// exact field derivation reads, so map a gap `type` to that storage field.
const choiceStorageField = (type) => (type === 'groups' ? 'groups' : 'items');

export function mergeChoices(existing = {}, specs = [], selected = {}) {
  const next = structuredClone(existing || {});
  const providers = new Map();
  for (const spec of specs) {
    if (!providers.has(spec.sourceId)) providers.set(spec.sourceId, new Map());
    providers.get(spec.sourceId).set(choiceStorageField(spec.type), spec.type);
  }
  for (const [providerId, fields] of providers) {
    const provider = { ...(next[providerId] || {}) };
    for (const [field, type] of fields) {
      const values = selected[`${providerId}:${type}`] || [];
      if (values.length) provider[field] = [...values];
      else delete provider[field];
    }
    if (Object.keys(provider).length) next[providerId] = provider;
    else delete next[providerId];
  }
  return next;
}

export function validateChoiceSelection(spec, selected) {
  const values = [...selected];
  if (new Set(values).size !== values.length || values.some((value) => !spec.options.includes(value))) return false;
  return values.length <= (spec.allowMultiple ? Infinity : spec.count);
}

async function fetchCatalog() {
  if (catalog) return catalog;
  const response = await fetch('modules/foundry-rme/data/catalog.json');
  if (!response.ok) throw new Error(`Catalog request failed (${response.status})`);
  catalog = await response.json();
  return catalog;
}

// ---------------------------------------------------------------------------
// Automatic training sync
// ---------------------------------------------------------------------------

const PROVIDER_TYPES = new Set(['class', 'race', 'subclass', 'feat']);

export function isProviderType(type) {
  return PROVIDER_TYPES.has(type);
}

function isEmbeddedActorItem(item) {
  return Boolean(item && item.parent && item.parent.documentName === 'Actor');
}

function isRmeCatalogItem(item) {
  return Boolean(item && item.flags?.[ID]?.catalogId);
}

// A create/delete event is relevant when the embedded item is a training
// provider (class/race/subclass/feat) or an RME catalog item with a catalogId.
export function shouldSyncItem(item) {
  if (!isEmbeddedActorItem(item)) return false;
  return isProviderType(item.type) || isRmeCatalogItem(item);
}

// Update events only re-sync for provider items. RME catalog items are the
// *output* of syncActorRme, so treating their updates as triggers would re-sync
// in a feedback loop; the diff guard in syncActorItems makes that idempotent but
// the per-provider gate keeps the hook from firing at all.
export function shouldSyncItemUpdate(item) {
  if (!isEmbeddedActorItem(item)) return false;
  return isProviderType(item.type);
}

export function hasProviderItems(actor) {
  return Boolean(actor) && [...(actor.items || [])].some((item) => isProviderType(item.type));
}

function hasOwnKey(record, key) {
  return Boolean(record) && Object.prototype.hasOwnProperty.call(record, key);
}

// An actor update re-syncs only when training-relevant state changed: the
// original class, or the module-owned `training` / `choices` flags. Both the
// nested and dotted update shapes are handled because Foundry may expand or
// keep dotted keys in the diff that reaches the update hook.
export function shouldSyncActorUpdate(data) {
  if (!data || typeof data !== 'object') return false;
  if (hasOwnKey(data.flags?.[ID], 'training')) return true;
  if (hasOwnKey(data.flags?.[ID], 'choices')) return true;
  if (hasOwnKey(data, `flags.${ID}.training`)) return true;
  if (hasOwnKey(data, `flags.${ID}.choices`)) return true;
  if (hasOwnKey(data.system?.details, 'originalClass')) return true;
  if (hasOwnKey(data, 'system.details.originalClass')) return true;
  return false;
}

// Per-actor coalescing queue. Multiple hook events for the same actor in one
// tick schedule a single microtask; only one sync runs per actor at a time. A
// trigger that arrives while a sync is already in flight records the actor as
// dirty and the sync loop reruns once the in-progress sync settles, repeating as
// long as further events keep arriving, so a training-sync event is never
// discarded. Ownership is re-checked before every run and the entry is always
// cleared on exit so later events can schedule a fresh sync.
const actorSyncState = new Map(); // actor id -> { running: bool, dirty: bool }

async function runActorSync(actor) {
  const data = await fetchCatalog();
  return syncActorRme(actor, data.equipment);
}

async function runActorSyncLoop(actor, id, state) {
  try {
    while (true) {
      state.dirty = false;
      if (!actor.isOwner) break;
      try {
        await runActorSync(actor);
      } catch (error) {
        notifyError(error);
      }
      if (!state.dirty) break;
    }
  } finally {
    state.running = false;
    actorSyncState.delete(id);
  }
}

export function queueActorSync(actor) {
  if (!actor || !actor.isOwner) return false;
  const id = actor.id;
  if (!id) return false;
  let state = actorSyncState.get(id);
  if (state?.running) {
    state.dirty = true;
    return true;
  }
  if (!state) {
    state = { running: false, dirty: false };
    actorSyncState.set(id, state);
  }
  state.running = true;
  queueMicrotask(() => runActorSyncLoop(actor, id, state));
  return true;
}

export async function syncActor(actor) {
  return runActorSync(actor);
}

export async function getTraining(actor) {
  const data = await fetchCatalog();
  return computeActorTraining(actor, data.equipment);
}

export async function importCatalog({ actor = null, ids = null, training = null } = {}) {
  if (!actor && !game.user.isGM) throw new Error('A GM is required to import Items into the world.');
  if (actor && !actor.isOwner) throw new Error('You do not have permission to edit this actor.');
  const data = await fetchCatalog();
  const chosen = data.equipment.filter((e) => !ids || ids.has(e.id));
  const existing = actor ? [...actor.items] : [...game.items];
  const have = new Set(existing.map((i) => i.flags?.[ID]?.catalogId).filter(Boolean));
  const effective = actor ? computeActorTraining(actor, data.equipment).effective : null;
  const creates = chosen.filter((e) => !have.has(e.id)).map((e) => {
    const level = effective ? (effective.items[e.id] ?? 'untrained') : resolveTraining(e, training ?? {});
    const item = makeItemData(e, level);
    item.flags = { ...(item.flags || {}), [ID]: { ...(item.flags?.[ID] || {}), catalogId: e.id } };
    return item;
  });
  if (creates.length) {
    if (actor) await actor.createEmbeddedDocuments('Item', creates);
    else await Item.createDocuments(creates);
  }
  if (actor) await syncActorRme(actor, data.equipment);
  return creates.length;
}

export async function openCatalog(initialActor = null) {
  try {
    const data = await fetchCatalog();
    const Dialog = foundry.applications.api.DialogV2;
    const dialog = new Dialog({ window: { title: 'RME Catalog' }, position: { width: 900, height: 760 }, content: catalogMarkup(data), buttons: [{ action: 'close', label: 'Close' }] });
    await dialog.render(true);
    bindCatalog(dialog.element, data, initialActor);
  } catch (e) { notifyError(e); }
}

function catalogMarkup(data) {
  return `<section class="rme-dialog"><p>Browse all ${data.equipment.length} equipment entries and ${data.references.length} reference sections. Source text is shown literally.</p><div class="rme-toolbar"><label>Search <input type="search" data-rme-search></label><label>Group <select data-rme-filter><option value="">All groups</option>${[...new Set(data.equipment.map(x=>x.group))].sort().map(g=>`<option>${esc(g)}</option>`).join('')}</select></label><button type="button" data-rme-all>Select visible</button><button type="button" data-rme-none>Clear</button></div>${game.user.isGM ? '<div class="rme-toolbar"><button type="button" data-rme-import-selected>Import selected to world</button><button type="button" data-rme-import-all>Import all to world</button></div>' : ''}<div class="rme-toolbar"><label>Import to owned actor <select data-rme-actor><option value="">Choose actor...</option>${[...game.actors].filter(a=>a.isOwner).map(a=>`<option value="${esc(a.id)}">${esc(a.name)}</option>`).join('')}</select></label><button type="button" data-rme-import-actor>Import selected to actor</button></div><div class="rme-list">${data.equipment.map(e=>`<article class="rme-row" data-rme-entry data-name="${esc(`${e.name} ${e.group} ${e.description}`.toLowerCase())}" data-group="${esc(e.group)}"><label><input type="checkbox" data-rme-select value="${esc(e.id)}"> <strong>${esc(e.name)}</strong><div class="rme-muted">${esc(e.group)} / ${esc(e.kind)}</div></label><span>${esc(e.tiers?.join('\n') || '')}</span><details><summary>Full source</summary><pre class="rme-source">${esc(e.description)}</pre></details></article>`).join('')}</div><h2>References</h2>${data.references.map(r=>`<details class="rme-reference"><summary>${esc(r.title)}</summary><p class="rme-muted">${esc(r.source)}</p><pre class="rme-source">${esc(r.content)}</pre></details>`).join('')}</section>`;
}

function bindCatalog(root, data, initialActor) {
  const actorSelect = root.querySelector('[data-rme-actor]');
  if (initialActor?.isOwner && actorSelect) actorSelect.value = initialActor.id;
  const filter = () => { const q=root.querySelector('[data-rme-search]').value.toLowerCase(); const group=root.querySelector('[data-rme-filter]').value; for (const row of root.querySelectorAll('[data-rme-entry]')) row.hidden=!(row.dataset.name.includes(q)&&(!group||row.dataset.group===group)); };
  root.querySelector('[data-rme-search]').addEventListener('input', filter); root.querySelector('[data-rme-filter]').addEventListener('change',filter);
  root.querySelector('[data-rme-all]').addEventListener('click',()=>root.querySelectorAll('[data-rme-entry]:not([hidden]) [data-rme-select]').forEach(x=>x.checked=true));
  root.querySelector('[data-rme-none]').addEventListener('click',()=>root.querySelectorAll('[data-rme-select]').forEach(x=>x.checked=false));
  const selected = () => new Set([...root.querySelectorAll('[data-rme-select]:checked')].map(el=>el.value));
  const run = async (actor, ids) => { try { const count=await importCatalog({actor, ids}); ui.notifications.info(`Imported ${count} new catalog Items${actor ? ` to ${actor.name}` : ''}.`); } catch (e) { notifyError(e); } };
  root.querySelector('[data-rme-import-selected]')?.addEventListener('click',()=>run(null,selected()));
  root.querySelector('[data-rme-import-all]')?.addEventListener('click',()=>run(null,null));
  root.querySelector('[data-rme-import-actor]')?.addEventListener('click',()=>{ const actor=game.actors.get(root.querySelector('[data-rme-actor]').value); if(!actor) return notifyError(new Error('Choose an owned actor first.')); run(actor,selected()); });
}

export async function openTraining(actor) {
  if (!actor) actor = canvas?.tokens?.controlled?.[0]?.actor || game.user.character;
  if (!actor) throw new Error('Select a token or assign a character first.');
  if (!actor?.isOwner) throw new Error('You must own this actor to edit training.');
  const data=await fetchCatalog(), picture=computeActorTraining(actor,data.equipment), state=picture.manual, choices=actor.getFlag(ID,'choices')||{}, groups=[...new Set(data.equipment.map(e=>e.group))].sort();
  const specs=choiceSpecs(actor,data.equipment), choiceGroups=new Map(), choiceItems=new Map();
  for(const spec of specs){const target=spec.type==='groups'?choiceGroups:choiceItems;target.set(`${spec.sourceId}:${spec.type}`,spec);}
  const optionsMarkup=(kind,key,opts,selected,count)=>`<fieldset class="rme-choice"><legend>Choose up to ${count} ${kind==='groups'?'categories':'items'} (${selected.length}/${count})</legend><div class="rme-choice-options">${opts.map(x=>{const id=x;const name=kind==='groups'?x:(data.equipment.find(e=>e.id===x)?.name||x);return `<label><input type="checkbox" data-choice-kind="${kind}" data-choice-provider="${esc(key)}" value="${esc(id)}" ${selected.includes(id)?'checked':''}> ${esc(name)}</label>`}).join('')}</div></fieldset>`;
  const providers=[...(actor.items||[])].filter(i=>isProviderType(i.type));
  const choicePanels=providers.map(p=>{const id=p.id||p._id;const gs=choiceGroups.get(`${id}:groups`),it=choiceItems.get(`${id}:choices`);return `<article class="rme-source-choice"><h3>${esc(p.name)} <span class="rme-muted">${esc(p.type)}</span></h3>${gs?optionsMarkup('groups',id,gs.options,choices[id]?.groups||[],gs.count):''}${it?optionsMarkup('choices',id,it.options,choices[id]?.items||[],it.count):''}</article>`}).join('');
  const sources=(picture.sources||[]).map(s=>`<li><strong>${esc(s.label||s.name||s.sourceId)}</strong> <span class="rme-muted">${esc(s.type||'source')}</span> <span>${Object.keys(s.grants?.groups||{}).length} categories / ${Object.keys(s.grants?.items||{}).length} items</span></li>`).join('');
  const gaps=(picture.gaps||[]).map(g=>`<li><strong>${esc(g.label||'Source')}</strong>: ${esc(g.reason)}${g.type==='unknown'?' <span>Review this trait, feat, or species grant manually; RME will not guess.</span>':''}</li>`).join('');
  const content=`<section class="rme-dialog rme-training"><p>Automatic proficiencies come from actor sources. Manual overrides take precedence; Inherit removes an override.</p><section class="rme-training-panel"><h2>Sources</h2><ul>${sources||'<li>No recognized training sources yet.</li>'}</ul></section>${gaps?`<section class="rme-training-gaps"><h2>Needs attention (${picture.gaps.length})</h2><ul>${gaps}</ul></section>`:''}<section class="rme-training-panel"><h2>Source choices</h2>${choicePanels||'<p class="rme-muted">No unresolved source choices.</p>'}</section><div class="rme-toolbar"><label>Search <input type="search" data-rme-search></label><label>Group <select data-rme-filter><option value="">All groups</option>${groups.map(g=>`<option>${esc(g)}</option>`).join('')}</select></label></div><div class="rme-list">${groups.map(g=>`<details open class="rme-reference"><summary>${esc(g)} <label>Manual group override <select data-rme-group="${esc(g)}"><option value="">Inherit</option>${options()}</select></label></summary>${data.equipment.filter(e=>e.group===g).map(e=>{const manualLevel=state.items?.[e.id]??state.groups?.[g];const origin=Object.hasOwn(state.items||{},e.id)?'manual item override':Object.hasOwn(state.groups||{},g)?'manual group override':Object.hasOwn(picture.derived.items||{},e.id)?'derived source':Object.hasOwn(picture.derived.groups||{},g)?'derived source':'natural default';return `<article class="rme-row" data-rme-entry data-name="${esc(`${e.name} ${e.group}`.toLowerCase())}" data-group="${esc(g)}"><div><h3>${esc(e.name)}</h3><div class="rme-muted">Effective: ${esc(picture.effective.items[e.id])} <span class="rme-origin">${esc(origin)}</span></div></div><span class="rme-muted">${esc(e.tiers?.join('\n')||'')}</span><label>Manual override <select data-rme-item="${esc(e.id)}"><option value="inherit">Inherit</option>${options()}</select></label></article>`}).join('')}</details>`).join('')}</div></section>`;
  const Dialog = foundry.applications.api.DialogV2;
  const dlg=new Dialog({window:{title:`RME Training - ${actor.name}`},position:{width:960,height:800},content,buttons:[{action:'save',label:'Save training',icon:'fa-solid fa-check',default:true,callback:async()=>{try{if(!actor.isOwner)throw new Error('Actor ownership is required.');const groups={},items={},selected={};for(const el of dlg.element.querySelectorAll('[data-rme-group]'))if(el.value)groups[el.dataset.rmeGroup]=el.value;for(const el of dlg.element.querySelectorAll('[data-rme-item]'))if(el.value!=='inherit')items[el.dataset.rmeItem]=el.value;for(const spec of specs){const key=`${spec.sourceId}:${spec.type}`,values=[...dlg.element.querySelectorAll(`[data-choice-provider="${CSS.escape(spec.sourceId)}"][data-choice-kind="${spec.type}"]:checked`)].map(x=>x.value);if(!validateChoiceSelection(spec,values))throw new Error(`${spec.label}: choices must be valid and no more than ${spec.count}.`);selected[key]=values;}const nextChoices=mergeChoices(choices,specs,selected);const next={};if(Object.keys(groups).length)next.groups=groups;if(Object.keys(items).length)next.items=items;await replaceTrainingFlag(actor,state,next,'training');await replaceTrainingFlag(actor,choices,nextChoices,'choices');await syncActorRme(actor,data.equipment);ui.notifications.info('RME training and source choices saved.');}catch(error){notifyError(error);throw error;}}}]});
  await dlg.render(true);
  for(const el of dlg.element.querySelectorAll('[data-rme-group]'))el.value=state.groups?.[el.dataset.rmeGroup]||'';
  for(const el of dlg.element.querySelectorAll('[data-rme-item]'))el.value=state.items?.[el.dataset.rmeItem]||'inherit';
  const search=dlg.element.querySelector('[data-rme-search]'),filter=dlg.element.querySelector('[data-rme-filter]');const run=()=>{const q=search.value.toLowerCase();for(const row of dlg.element.querySelectorAll('[data-rme-entry]'))row.hidden=!(row.dataset.name.includes(q)&&(!filter.value||row.dataset.group===filter.value));};search.addEventListener('input',run);filter.addEventListener('change',run);
}

Hooks.once('ready',()=>{
  game.rme={openCatalog,openTraining,importCatalog,syncActorItems,getTraining,syncActor};
  Hooks.on('getHeaderControlsApplicationV2',(app,controls)=>{
    const ActorSheet = foundry.applications.sheets.ActorSheetV2;
    if (!(app instanceof ActorSheet)) return;
    const actor=app?.document; if(!actor || actor.documentName!=='Actor' || !actor.isOwner) return;
      controls.push({action:'rme-training',label:'RME Training',icon:'fa-solid fa-dumbbell',onClick:()=>openTraining(actor).catch(notifyError)});
    if(game.user.isGM) controls.push({action:'rme-catalog',label:'RME Catalog',icon:'fa-solid fa-book-open',onClick:()=>openCatalog(actor).catch(notifyError)});
  });
});

Hooks.on('init',()=>{
  if(!globalThis.foundry?.applications?.api?.DialogV2) console.warn(`[${ID}] DialogV2 is unavailable; verify Foundry v14.`);
});

const itemParentActor = (item) => item?.parent;
Hooks.on('createItem',(item)=>{ if (shouldSyncItem(item)) queueActorSync(itemParentActor(item)); });
Hooks.on('deleteItem',(item)=>{ if (shouldSyncItem(item)) queueActorSync(itemParentActor(item)); });
Hooks.on('updateItem',(item)=>{ if (shouldSyncItemUpdate(item)) queueActorSync(itemParentActor(item)); });
Hooks.on('updateActor',(actor,data)=>{ if (shouldSyncActorUpdate(data)) queueActorSync(actor); });
Hooks.on('createActor',(actor)=>{ if (hasProviderItems(actor)) queueActorSync(actor); });
