import { computeActorTraining } from './actor-training.mjs';
import { summarizeRmeProficiencies } from './proficiency-summary.mjs';

const positive = (rows) => rows.length > 0;
const expert = (level) => level === 'expert';

function makePill(document, label, level, extraClass = '') {
  const pill = document.createElement('li');
  pill.className = `pill rme-proficiency-pill${expert(level) ? ' rme-proficiency-expert' : ''}${extraClass ? ` ${extraClass}` : ''}`;
  pill.textContent = label;
  pill.title = `${label}: ${expert(level) ? 'Expert' : 'Proficient'}`;
  pill.setAttribute('aria-label', pill.title);
  if (expert(level)) {
    const cue = document.createElement('span');
    cue.className = 'rme-proficiency-expert-cue';
    cue.setAttribute('aria-hidden', 'true');
    cue.textContent = '★';
    pill.append(cue);
  }
  return pill;
}

function createRow(document, row) {
  if (row.kind === 'class') {
    const item = document.createElement('li');
    item.className = `pill rme-proficiency-pill rme-proficiency-class${expert(row.level) ? ' rme-proficiency-expert' : ''}`;
    const disclosure = document.createElement('details');
    disclosure.className = 'rme-proficiency-class-disclosure';
    disclosure.setAttribute('data-class-label', row.label);
    const summary = document.createElement('summary');
    summary.setAttribute('aria-label', row.level ? `${row.label}: ${row.level === 'expert' ? 'Expert' : 'Proficient'}` : `${row.label}: Mixed tiers`);
    summary.title = row.level ? `${row.label}: ${row.level === 'expert' ? 'Expert' : 'Proficient'}` : `${row.label}: Mixed tiers`;
    const label = document.createElement('span'); label.className = 'rme-proficiency-label'; label.textContent = row.label;
    summary.append(label);
    if (row.level) {
      if (expert(row.level)) { const cue = document.createElement('span'); cue.className = 'rme-proficiency-expert-cue'; cue.setAttribute('aria-hidden', 'true'); cue.textContent = '★'; summary.append(cue); }
    } else {
      const mixed = document.createElement('span'); mixed.className = 'rme-proficiency-count'; mixed.textContent = 'Mixed tiers'; mixed.title = 'This class group contains different proficiency tiers'; summary.append(mixed);
    }
    const count = document.createElement('span'); count.className = 'rme-proficiency-count'; count.textContent = `${row.items.length} item${row.items.length === 1 ? '' : 's'}`; summary.append(count);
    const list = document.createElement('ul'); list.className = 'pills rme-proficiency-class-items';
    for (const entry of row.items) list.append(makePill(document, entry.label, entry.level));
    disclosure.append(summary, list); item.append(disclosure); return item;
  }

  const item = makePill(document, row.label, row.level, row.kind === 'item' ? 'rme-proficiency-item' : '');
  if (row.kind === 'category' && row.exceptions?.length) {
    const positiveExceptions = row.exceptions.filter((exception) => exception.level === 'proficient' || exception.level === 'expert');
    const exclusions = row.exceptions.filter((exception) => !positiveExceptions.includes(exception));
    if (positiveExceptions.length) item.title += `; different tier: ${positiveExceptions.map((entry) => `${entry.label}: ${entry.level === 'expert' ? 'Expert' : 'Proficient'}`).join(', ')}`;
    if (exclusions.length) {
      const disclosure = document.createElement('details');
      disclosure.className = 'rme-proficiency-exceptions';
      const summary = document.createElement('summary');
      summary.textContent = `${exclusions.length} exclusion${exclusions.length === 1 ? '' : 's'}`;
      const list = document.createElement('ul'); list.className = 'rme-proficiency-exception-list';
      for (const exception of exclusions) {
        const entry = document.createElement('li');
        entry.textContent = `${exception.label}: ${exception.level[0].toUpperCase()}${exception.level.slice(1)}`;
        list.append(entry);
      }
      disclosure.append(summary, list);
      item.append(disclosure);
    }
  }
  return item;
}

function makeSection(document, title, icon, rows) {
  if (!positive(rows)) return null;
  const section = document.createElement('section');
  section.className = 'pills-group rme-proficiency-section';
  const heading = document.createElement('h3');
  heading.className = 'icon roboto-upper';
  const glyph = document.createElement('dnd5e-icon');
  glyph.setAttribute('src', `systems/dnd5e/icons/svg/${icon}.svg`);
  heading.append(glyph, document.createTextNode ? document.createTextNode(title) : Object.assign(document.createElement('span'), { textContent: title }));
  const list = document.createElement('ul');
  list.className = 'pills rme-proficiency-list';
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
  const openLabels = new Set(existing ? [...existing.querySelectorAll('details.rme-proficiency-class-disclosure[open]')].map((node) => node.getAttribute('data-class-label')) : []);
  const armor = makeSection(document, 'RME ARMOR', 'checked-shield', summary.armor);
  const weapons = makeSection(document, 'RME WEAPONS', 'trait-weapon-proficiencies', summary.weapons);
  if (!armor && !weapons) { existing?.remove(); return; }
  const panel = existing || document.createElement('div');
  panel.setAttribute('data-rme-proficiencies', '');
  panel.className = 'rme-proficiencies';
  panel.replaceChildren(...[armor, weapons].filter(Boolean));
  for (const disclosure of panel.querySelectorAll('details.rme-proficiency-class-disclosure')) {
    if (openLabels.has(disclosure.getAttribute('data-class-label'))) disclosure.open = true;
  }
  if (existing) return;
  const weaponPill = details.querySelector('[data-trait="weapon"]')?.closest('.pills-group');
  if (weaponPill?.parentNode) weaponPill.after(panel);
  else details.append(panel);
}
