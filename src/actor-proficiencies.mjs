import { computeActorTraining } from './actor-training.mjs';
import { summarizeRmeProficiencies } from './proficiency-summary.mjs';

const positive = (rows) => rows.length > 0;

function makeBadge(document, level) {
  const badge = document.createElement('span');
  badge.className = `rme-proficiency-badge${level === 'expert' ? ' rme-proficiency-expert' : ''}`;
  badge.textContent = level === 'expert' ? 'Expert' : 'Proficient';
  badge.title = `${level === 'expert' ? 'Expert' : 'Proficient'} RME proficiency`;
  badge.setAttribute('aria-label', badge.title);
  return badge;
}

function createRow(document, row) {
  const item = document.createElement('li');
  item.className = `rme-proficiency-row${row.kind === 'item' ? ' rme-proficiency-item' : ''}`;
  const label = document.createElement('span');
  label.className = 'rme-proficiency-label';
  label.textContent = row.label;
  item.append(label, makeBadge(document, row.level));
  if (row.kind === 'category' && row.exceptions?.length) {
    const disclosure = document.createElement('details');
    disclosure.className = 'rme-proficiency-exceptions';
    const summary = document.createElement('summary');
    summary.textContent = `${row.exceptions.length} exception${row.exceptions.length === 1 ? '' : 's'}`;
    const exceptions = document.createElement('ul');
    for (const exception of row.exceptions) {
      const entry = document.createElement('li');
      entry.textContent = `${exception.label}: ${exception.level[0].toUpperCase()}${exception.level.slice(1)}`;
      exceptions.append(entry);
    }
    disclosure.append(summary, exceptions);
    item.append(disclosure);
  }
  return item;
}

function makeSection(document, title, rows) {
  if (!positive(rows)) return null;
  const section = document.createElement('section');
  section.className = 'rme-proficiency-section';
  const heading = document.createElement('h3');
  heading.textContent = title;
  const list = document.createElement('ul');
  list.className = 'rme-proficiency-list';
  for (const row of rows) list.append(createRow(document, row));
  section.append(heading, list);
  return section;
}

export function renderActorRmeProficiencies(app, element, equipment) {
  const actor = app?.document;
  if (!actor || !(actor.type === 'character' || (actor.documentName === 'Actor' && actor.type === 'character'))) return;
  const details = element?.querySelector?.('section[data-tab="details"] .right');
  if (!details) return;
  const document = element.ownerDocument || globalThis.document;
  const existing = details.querySelector('[data-rme-proficiencies]');
  const picture = computeActorTraining(actor, equipment);
  const summary = summarizeRmeProficiencies(equipment, picture);
  const armor = makeSection(document, 'RME Armor', summary.armor);
  const weapons = makeSection(document, 'RME Weapons', summary.weapons);
  if (!armor && !weapons) {
    existing?.remove();
    return;
  }
  const panel = existing || document.createElement('div');
  panel.setAttribute('data-rme-proficiencies', '');
  panel.className = 'rme-proficiencies';
  panel.replaceChildren(...[armor, weapons].filter(Boolean));
  if (existing) return;
  const weaponPill = details.querySelector('[data-trait="weapon"]')?.closest('.pills-group');
  if (weaponPill?.parentNode) weaponPill.after(panel);
  else details.append(panel);
}
