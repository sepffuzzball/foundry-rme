import { tierProperties } from './rme-metadata.mjs';
import { computeActorTraining, syncActorRme } from './actor-training.mjs';
import { ammoFamily } from './ammunition.mjs';
import { getAmmoState, assignActorAmmo, reloadActorAmmo } from './ammo-runtime.mjs';

const MODULE = 'foundry-rme';
const LEVELS = ['untrained', 'proficient', 'expert'];
const label = (level) => ({ untrained: 'Untrained', proficient: 'Basic (Proficient)', expert: 'Expert (Mastery)' })[level] || 'Untrained';
const escapeHtml = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
const levelOf = (level) => LEVELS.includes(level) ? level : 'untrained';
const isCompendium = (item) => Boolean(item?.pack);

function propertiesMarkup(entry, level) {
  const properties = tierProperties(entry, level);
  if (!properties.length) return '<p class="rme-muted">No RME properties at this tier.</p>';
  return `<ul class="rme-item-properties">${properties.map((property) => `<li><label><input type="checkbox" disabled checked> <strong>${escapeHtml(property.label)}</strong>${property.raw !== property.label ? ` <span>${escapeHtml(property.raw)}</span>` : ''}</label></li>`).join('')}</ul>`;
}

function profileMarkup(entry, level, active) {
  const rawRows = (entry.tiers || []).filter((row) => {
    const match = /^(Untrained|Proficient|Basic|Expert)\s*/i.exec(row);
    const tier = match?.[1]?.toLowerCase();
    return level === 'untrained' ? tier === 'untrained' : level === 'proficient' ? ['basic', 'proficient'].includes(tier) : tier === 'expert';
  });
  const rows = rawRows.map((row) => `<li>${escapeHtml(row)}</li>`).join('') || '<li class="rme-muted">No profile row provided.</li>';
  return `<details class="rme-item-profile" ${active ? 'open' : ''}><summary>${escapeHtml(label(level))}${active ? ' <span class="rme-item-active">Active profile</span>' : ''}</summary><ul>${rows}</ul>${propertiesMarkup(entry, level)}${level === 'expert' && entry.expertPerk ? `<div class="rme-item-perk"><strong>Expert Perk<span data-rme-perk-status>${active ? ' - Active' : ''}</span></strong><p>${escapeHtml(entry.expertPerk)}</p></div>` : ''}</details>`;
}

export async function renderRmeItemDetails(app, element, catalog) {
  const item = app?.document;
  const entryId = item?.flags?.[MODULE]?.catalogId;
  const entry = catalog?.equipment?.find((candidate) => candidate.id === entryId);
  const details = element?.querySelector?.('section[data-tab="details"]');
  if (!entry || !details || element.isConnected === false || details.querySelector('[data-rme-item-panel]')) return false;

  const actor = item.parent?.documentName === 'Actor' ? item.parent : null;
  const canEdit = Boolean(actor?.isOwner) && !isCompendium(item);
  let effective = 'untrained';
  let manual = {};
  if (actor) {
    const picture = computeActorTraining(actor, catalog.equipment);
    effective = levelOf(picture.effective.items[entry.id]);
    manual = picture.manual || {};
  }
  let preview = actor ? effective : levelOf(item.flags?.[MODULE]?.activeTier || (item.system?.proficient ? 'proficient' : 'untrained'));
  const storedManual = Object.hasOwn(manual.items || {}, entry.id) ? manual.items[entry.id] : 'inherit';
  const manualValue = LEVELS.includes(storedManual) ? storedManual : 'inherit';
  const choices = LEVELS.map((level) => `<option value="${level}" ${level === (canEdit ? manualValue : preview) ? 'selected' : ''}>${escapeHtml(label(level))}</option>`).join('');
  const family = ammoFamily(entry);
  const showAmmo = Boolean(family && actor);
  let ammo = showAmmo ? getAmmoState(actor, item.id, catalog.equipment) : null;
  const ammoMarkup = () => {
    if (!family) return '';
    if (!showAmmo) {
      return `<section data-rme-ammo-region class="rme-ammo" aria-label="RME ammunition"><h3>Ammunition</h3><p class="rme-muted">Import to actor to assign ammo.</p></section>`;
    }
    const state = ammo.state;
    const reserve = ammo.compatibleItems.find((stack) => stack.id === state.reserveItemId);
    const loadedStack = ammo.compatibleItems.find((stack) => stack.ammoId === state.loadedAmmoId);
    const direct = ammo.capacity <= 0;
    const options = ammo.compatibleItems.map((stack) => `<option value="${escapeHtml(stack.id)}" ${stack.id === state.reserveItemId ? 'selected' : ''}>${escapeHtml(stack.name)} (${stack.quantity})</option>`).join('');
    const placeholder = `<option value="" ${!reserve ? 'selected' : ''}>Choose a reserve stack</option>`;
    const controls = canEdit && ammo.compatibleItems.length
      ? `<label class="rme-item-control">Reserve ammunition <select data-rme-ammo-select>${placeholder}${options}</select></label>${!direct ? `<div class="rme-item-control">${ammo.options.map((option) => `<button type="button" data-rme-reload="${escapeHtml(option.id)}">${escapeHtml(option.label || option.id)}</button>`).join('')}</div>` : ''}`
      : '';
    const guidance = family === 'javelin'
      ? 'Add a Javelin weapon item to the actor to assign ammo.'
      : 'Import ammunition from the RME Ammunition pack.';
    return `<section data-rme-ammo-region class="rme-ammo" aria-label="RME ammunition"><h3>Ammunition</h3>${reserve ? `<p>Reserve: <strong>${escapeHtml(reserve.name)}</strong> (${reserve.quantity} remaining)</p>` : `<p>No compatible reserve stack assigned.</p>`}${state.reserveItemId && !reserve ? '<p class="rme-ammo-warning">Assigned reserve is depleted or unavailable.</p>' : ''}${direct ? `<p>Direct ammunition: ${reserve ? reserve.quantity : 0} remaining; no magazine or reload.</p>` : `<p>Magazine: ${state.loaded ?? 0}/${ammo.capacity} loaded</p>`}${state.loadedAmmoId ? `<p>Loaded ammunition: ${escapeHtml(loadedStack?.name || state.loadedAmmoId)}${!loadedStack ? ' <span class="rme-ammo-warning">(reserve changed; loaded rounds remain)</span>' : ''}</p>` : ''}${controls}${!ammo.compatibleItems.length ? `<p>${escapeHtml(guidance)}</p>` : ''}${!canEdit ? '<p>Assign ammunition on an actor.</p>' : ''}</section>`;
  };
  const dropdown = canEdit
    ? `<label class="rme-item-control">Manual item training <select data-rme-training><option value="inherit" ${manualValue === 'inherit' ? 'selected' : ''}>Inherit</option>${choices}</select></label>`
    : `<label class="rme-item-control">Tier preview <select data-rme-preview>${choices}</select></label>`;
  const panel = document.createElement('section');
  panel.className = 'rme-item-panel';
  panel.dataset.rmeItemPanel = '';
  panel.innerHTML = `<header class="rme-item-heading"><div><p class="rme-item-eyebrow">RME Equipment</p><h2>${escapeHtml(entry.name)}</h2><p>${escapeHtml(entry.group)}${entry.kind ? ` / ${escapeHtml(entry.kind)}` : ''}</p></div><span class="rme-item-tier" data-rme-tier>${escapeHtml(label(preview))}</span></header><p class="rme-item-equipped">${item.system?.equipped ? 'Equipped' : 'Not equipped'} <span>RME properties are available while equipped.</span></p>${dropdown}${ammoMarkup()}<div class="rme-item-profiles">${LEVELS.map((level) => profileMarkup(entry, level, level === preview)).join('')}</div><p class="rme-muted">RME properties are reference information; they do not provide tactical automation. Native dnd5e properties below are synchronized by the RME profile.</p>${showAmmo ? '<p class="rme-muted">RME-managed; native dnd5e ammo consumption is not used. Turn costs are player enforced.</p>' : ''}<div class="rme-item-error" data-rme-error role="alert" hidden></div>`;
  details.append(panel);

  const showPreview = (level) => {
    preview = levelOf(level);
    panel.querySelector('[data-rme-tier]').textContent = label(preview);
    panel.querySelectorAll('.rme-item-profile').forEach((profile, index) => {
      profile.open = LEVELS[index] === preview;
      const badge = profile.querySelector('.rme-item-active');
      if (badge) badge.remove();
      if (LEVELS[index] === preview) profile.querySelector('summary').insertAdjacentHTML('beforeend', ' <span class="rme-item-active">Active profile</span>');
    });
    const perkStatus = panel.querySelector('[data-rme-perk-status]');
    if (perkStatus) perkStatus.textContent = preview === 'expert' ? ' - Active' : '';
  };
  panel.querySelector('[data-rme-preview]')?.addEventListener('change', (event) => showPreview(event.currentTarget.value));
  const refreshAmmo = () => { const region = panel.querySelector('[data-rme-ammo-region]'); if (region) region.outerHTML = ammoMarkup(); };
  const updateAmmo = async (operation) => {
    const errorBox = panel.querySelector('[data-rme-error]');
    errorBox.hidden = true;
    try {
      ammo = await operation();
      refreshAmmo();
    } catch (error) {
      errorBox.textContent = error?.message || String(error);
      errorBox.hidden = false;
    }
  };
  panel.addEventListener('change', (event) => {
    const select = event.target?.matches?.('[data-rme-ammo-select]') ? event.target : null;
    if (select?.value) return updateAmmo(() => assignActorAmmo(actor, item.id, select.value, catalog.equipment));
  });
  panel.addEventListener('click', (event) => {
    const button = event.target?.closest?.('[data-rme-reload]');
    if (button) return updateAmmo(() => reloadActorAmmo(actor, item.id, button.dataset.rmeReload, catalog.equipment));
  });
  panel.querySelector('[data-rme-training]')?.addEventListener('change', async (event) => {
    const errorBox = panel.querySelector('[data-rme-error]');
    errorBox.hidden = true;
    try {
      if (!actor.isOwner) throw new Error('Actor ownership is required to edit training.');
      const current = actor.getFlag(MODULE, 'training') || {};
      const items = { ...(current.items || {}) };
      if (event.currentTarget.value === 'inherit') delete items[entry.id];
      else items[entry.id] = event.currentTarget.value;
      const next = { ...current };
      if (Object.keys(items).length) next.items = items;
      else delete next.items;
      if (Object.keys(next).length) await actor.setFlag(MODULE, 'training', next);
      else await actor.unsetFlag(MODULE, 'training');
      const picture = await syncActorRme(actor, catalog.equipment);
      showPreview(picture.effective.items[entry.id]);
      event.currentTarget.value = Object.hasOwn(picture.manual?.items || {}, entry.id) ? levelOf(picture.manual.items[entry.id]) : 'inherit';
      if (showAmmo) {
        ammo = getAmmoState(actor, item.id, catalog.equipment);
        refreshAmmo();
      }
    } catch (error) {
      const current = actor.getFlag(MODULE, 'training') || {};
      event.currentTarget.value = LEVELS.includes(current.items?.[entry.id]) ? current.items[entry.id] : 'inherit';
      errorBox.textContent = error?.message || String(error);
      errorBox.hidden = false;
    }
  });
  return true;
}
