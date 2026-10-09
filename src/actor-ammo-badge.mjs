import { computeActorTraining } from './actor-training.mjs';
import { ammoFamily, magazineCapacity, readAmmoState } from './ammunition.mjs';

const BADGE = '[data-rme-magazine-badge]';

export function renderActorAmmoBadges(app, element, equipment) {
  const actor = app?.document;
  if (actor?.documentName !== 'Actor' || !actor.items || !element?.querySelectorAll) return;
  const rows = [...element.querySelectorAll('li.item[data-item-id]')];
  if (!rows.length) return;
  const effective = computeActorTraining(actor, equipment);
  for (const row of rows) {
    const existing = row.querySelector(BADGE);
    const item = actor.items.get(row.dataset.itemId);
    const catalogId = item?.flags?.['foundry-rme']?.catalogId;
    const entry = catalogId && equipment.find((candidate) => candidate.id === catalogId);
    const capacity = item?.type === 'weapon' && ammoFamily(entry)
      ? magazineCapacity(entry, effective.effective.items[entry.id]) : 0;
    if (!(capacity > 0)) {
      existing?.remove();
      continue;
    }
    const state = readAmmoState(item);
    const loaded = Number.isFinite(Number(state.loaded)) ? Math.max(0, Math.floor(Number(state.loaded))) : 0;
    const badge = existing || document.createElement('span');
    badge.dataset.rmeMagazineBadge = '';
    badge.className = 'rme-magazine-badge';
    badge.textContent = `${loaded}/${capacity}`;
    const ammo = state.loadedAmmoId == null || String(state.loadedAmmoId).trim() === '' ? '' : ` (${state.loadedAmmoId})`;
    const label = `RME loaded ammunition: ${loaded} of ${capacity}${ammo}`;
    badge.setAttribute('title', label);
    badge.setAttribute('aria-label', label);
    if (!existing) {
      const name = row.querySelector('.item-name .name') || row.querySelector('.item-name');
      name?.append(badge);
      if (!name) badge.remove();
    }
  }
}
