import { tierProperties } from './rme-metadata.mjs';
import { computeActorTraining, syncActorRme } from './actor-training.mjs';

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
  const dropdown = canEdit
    ? `<label class="rme-item-control">Manual item training <select data-rme-training><option value="inherit" ${manualValue === 'inherit' ? 'selected' : ''}>Inherit</option>${choices}</select></label>`
    : `<label class="rme-item-control">Tier preview <select data-rme-preview>${choices}</select></label>`;
  const panel = document.createElement('section');
  panel.className = 'rme-item-panel';
  panel.dataset.rmeItemPanel = '';
  panel.innerHTML = `<header class="rme-item-heading"><div><p class="rme-item-eyebrow">RME Equipment</p><h2>${escapeHtml(entry.name)}</h2><p>${escapeHtml(entry.group)}${entry.kind ? ` / ${escapeHtml(entry.kind)}` : ''}</p></div><span class="rme-item-tier" data-rme-tier>${escapeHtml(label(preview))}</span></header><p class="rme-item-equipped">${item.system?.equipped ? 'Equipped' : 'Not equipped'} <span>RME properties are available while equipped.</span></p>${dropdown}<div class="rme-item-profiles">${LEVELS.map((level) => profileMarkup(entry, level, level === preview)).join('')}</div><p class="rme-muted">RME properties are reference information; they do not provide tactical automation. Native dnd5e properties below are synchronized by the RME profile.</p><div class="rme-item-error" data-rme-error role="alert" hidden></div>`;
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
    } catch (error) {
      const current = actor.getFlag(MODULE, 'training') || {};
      event.currentTarget.value = LEVELS.includes(current.items?.[entry.id]) ? current.items[entry.id] : 'inherit';
      errorBox.textContent = error?.message || String(error);
      errorBox.hidden = false;
    }
  });
  return true;
}
