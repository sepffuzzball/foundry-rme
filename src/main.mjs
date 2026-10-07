import { LEVELS, resolveTraining } from './training.mjs';
import { CLASS_IDS, eligibleGroups, classGrants } from './class-training.mjs';
import { makeItemData, syncActorItems } from './items.mjs';

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
export async function replaceTrainingFlag(actor, previous, next) {
  const hadPrevious = Object.keys(previous || {}).length > 0;
  if (hadPrevious) await actor.unsetFlag(ID, 'training');
  try { if (Object.keys(next || {}).length) await actor.setFlag(ID, 'training', next); }
  catch (error) { if (hadPrevious) { try { await actor.setFlag(ID, 'training', previous); } catch (restoreError) { console.error(`[${ID}] Failed to restore previous training flag`, restoreError); } } throw error; }
}

async function fetchCatalog() {
  if (catalog) return catalog;
  const response = await fetch('modules/foundry-rme/data/catalog.json');
  if (!response.ok) throw new Error(`Catalog request failed (${response.status})`);
  catalog = await response.json();
  return catalog;
}

export async function importCatalog({ actor = null, ids = null, training = null } = {}) {
  if (!actor && !game.user.isGM) throw new Error('A GM is required to import Items into the world.');
  if (actor && !actor.isOwner) throw new Error('You do not have permission to edit this actor.');
  const data = await fetchCatalog();
  const chosen = data.equipment.filter((e) => !ids || ids.has(e.id));
  const existing = actor ? [...actor.items] : [...game.items];
  const have = new Set(existing.map((i) => i.flags?.[ID]?.catalogId).filter(Boolean));
  const state = training ?? (actor ? readTraining(actor) : {});
  const creates = chosen.filter((e) => !have.has(e.id)).map((e) => {
    const item = makeItemData(e, resolveTraining(e, state));
    item.flags = { ...(item.flags || {}), [ID]: { ...(item.flags?.[ID] || {}), catalogId: e.id } };
    return item;
  });
  if (creates.length) {
    if (actor) await actor.createEmbeddedDocuments('Item', creates);
    else await Item.createDocuments(creates);
  }
  if (actor) await syncActorItems(actor, data.equipment, state);
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
  const data=await fetchCatalog(), state=readTraining(actor), groups=[...new Set(data.equipment.map(e=>e.group))].sort();
  const content=`<section class="rme-dialog"><p>Choose group training, then use item overrides for exceptions. “Untrained” is an explicit override; “Inherit” restores group/natural defaults.</p><p><strong>Automation boundary:</strong> only unambiguous base damage and training bonus sync. Tactical effects, class/ancestry/feat grants, and complex attack profiles remain manual.</p><fieldset class="rme-class-training"><legend>Optional starting-class training</legend><label>Class <select data-rme-class><option value="">Choose a class...</option>${CLASS_IDS.map(id=>`<option value="${esc(id)}">${esc(id[0].toUpperCase()+id.slice(1))}</option>`).join('')}</select></label><div data-rme-class-choices hidden></div><p class="rme-muted">Class grants are opt-in. Other training (including multiclass, species, and feats) must be added manually. Monk's weapon table is missing.</p><p data-rme-class-error class="rme-training-error" role="alert" hidden></p><button type="button" data-rme-apply-class>Apply class training</button></fieldset><div class="rme-toolbar"><label>Search <input type="search" data-rme-search></label><label>Group <select data-rme-filter><option value="">All groups</option>${groups.map(g=>`<option>${esc(g)}</option>`).join('')}</select></label></div><div class="rme-list">${groups.map(g=>`<details open class="rme-reference"><summary>${esc(g)} <label>Group training <select data-rme-group="${esc(g)}"><option value="">Untrained/default</option>${options()}</select></label></summary>${data.equipment.filter(e=>e.group===g).map(e=>`<article class="rme-row" data-rme-entry data-name="${esc(`${e.name} ${e.group}`.toLowerCase())}" data-group="${esc(g)}"><div><h3>${esc(e.name)}</h3><div class="rme-muted">Effective: ${esc(resolveTraining(e,state))}</div></div><span class="rme-muted">${esc(e.tiers?.join('\n')||'')}</span><label>Override <select data-rme-item="${esc(e.id)}"><option value="inherit">Inherit</option>${options()}</select></label></article>`).join('')}</details>`).join('')}</div></section>`;
  const Dialog = foundry.applications.api.DialogV2;
  const dlg=new Dialog({window:{title:`RME Training - ${actor.name}`},position:{width:920,height:760},content,buttons:[{action:'save',label:'Save training',icon:'fa-solid fa-check',default:true,callback:async()=>{try{if(!actor.isOwner)throw new Error('Actor ownership is required.');const groups={},items={};for(const el of dlg.element.querySelectorAll('[data-rme-group]'))if(el.value)groups[el.dataset.rmeGroup]=el.value;for(const el of dlg.element.querySelectorAll('[data-rme-item]'))if(el.value!=='inherit')items[el.dataset.rmeItem]=el.value;const next={};if(Object.keys(groups).length)next.groups=groups;if(Object.keys(items).length)next.items=items;ui.notifications.info('Saving training may temporarily unset its flag.');await replaceTrainingFlag(actor,state,next);const c=await fetchCatalog();await syncActorItems(actor,c.equipment,next);ui.notifications.info('RME training saved and actor Items synchronized.');}catch(e){notifyError(e);}}}]});
  await dlg.render(true);
  for(const el of dlg.element.querySelectorAll('[data-rme-group]'))el.value=state.groups?.[el.dataset.rmeGroup]||'';
  for(const el of dlg.element.querySelectorAll('[data-rme-item]'))el.value=state.items?.[el.dataset.rmeItem]||'inherit';
  const search=dlg.element.querySelector('[data-rme-search]'),filter=dlg.element.querySelector('[data-rme-filter]');const run=()=>{const q=search.value.toLowerCase();for(const row of dlg.element.querySelectorAll('[data-rme-entry]'))row.hidden=!(row.dataset.name.includes(q)&&(!filter.value||row.dataset.group===filter.value));};search.addEventListener('input',run);filter.addEventListener('change',run);
  const classSelect=dlg.element.querySelector('[data-rme-class]'), choices=dlg.element.querySelector('[data-rme-class-choices]'), error=dlg.element.querySelector('[data-rme-class-error]');
  classSelect.addEventListener('change',()=>{ error.hidden=true; const id=classSelect.value; if(!['fighter','barbarian','paladin','ranger'].includes(id)){choices.hidden=true;choices.replaceChildren();return;} const eligible=eligibleGroups(id,data.equipment); choices.innerHTML=`<p>Choose exactly 8 eligible weapon categories:</p><div class="rme-class-options">${eligible.map(g=>`<label><input type="checkbox" data-rme-category value="${esc(g)}"> ${esc(g)}</label>`).join('')}</div>`; choices.hidden=false; });
  dlg.element.querySelector('[data-rme-apply-class]').addEventListener('click',()=>{try{const id=classSelect.value;if(!id)throw new Error('Choose a class first.');const isChoice=['fighter','barbarian','paladin','ranger'].includes(id);const chosen=isChoice?[...choices.querySelectorAll('[data-rme-category]:checked')].map(el=>el.value):[];const grants=classGrants(id,data.equipment,chosen,{seed:isChoice});const groupSelects=[...dlg.element.querySelectorAll('[data-rme-group]')],itemSelects=[...dlg.element.querySelectorAll('[data-rme-item]')];const currentGroups=Object.fromEntries(groupSelects.filter(el=>el.value).map(el=>[el.dataset.rmeGroup,el.value])),currentItems=Object.fromEntries(itemSelects.filter(el=>el.value!=='inherit').map(el=>[el.dataset.rmeItem,el.value]));const updated=applyClassGrantSelections(trainingSnapshot(currentGroups,currentItems),grants,data.equipment);for(const el of groupSelects)el.value=updated.groups?.[el.dataset.rmeGroup]||'';for(const el of itemSelects)el.value=updated.items?.[el.dataset.rmeItem]||'inherit';error.hidden=true;}catch(e){error.textContent=e?.message||String(e);error.hidden=false;}});
}

Hooks.once('ready',()=>{
  game.rme={openCatalog,openTraining,importCatalog,syncActorItems};
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
