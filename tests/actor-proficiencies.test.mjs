import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { renderActorRmeProficiencies } from '../src/actor-proficiencies.mjs';
import catalog from '../data/catalog.json' with { type: 'json' };

class Node {
  constructor(tag = 'div') { this.tagName = tag; this.children = []; this.attributes = {}; this.parentNode = null; this.className = ''; this.textContent = ''; }
  append(...nodes) { for (const node of nodes) { node.parentNode = this; this.children.push(node); } }
  replaceChildren(...nodes) { this.children = []; this.append(...nodes); }
  setAttribute(key, value) { this.attributes[key] = value; }
  getAttribute(key) { return this.attributes[key]; }
  remove() { if (this.parentNode) this.parentNode.children = this.parentNode.children.filter((item) => item !== this); }
  after(node) { const siblings = this.parentNode.children; const index = siblings.indexOf(this); node.parentNode = this.parentNode; siblings.splice(index + 1, 0, node); }
  closest(selector) { return selector === '.pills-group' && this.pillGroup ? this.pillGroup : null; }
  querySelector(selector) {
    if (selector === '[data-rme-proficiencies]') return this.children.find((child) => child.attributes['data-rme-proficiencies'] !== undefined) || null;
    if (selector === '[data-trait="weapon"]') return this.weaponTrait || null;
    return null;
  }
  querySelectorAll(selector) {
    const all = descendants(this, '*');
    if (selector === 'details.rme-proficiency-class-disclosure') return all.filter((node) => node.tagName === 'details' && node.className === 'rme-proficiency-class-disclosure');
    if (selector === 'details.rme-proficiency-class-disclosure[open]') return all.filter((node) => node.tagName === 'details' && node.className === 'rme-proficiency-class-disclosure' && node.open);
    return [];
  }
}
function descendants(node, tag) { return node.children.flatMap((child) => [ ...(tag === '*' || child.tagName === tag ? [child] : []), ...descendants(child, tag) ]); }
function text(node) { return `${node.textContent || ''}${node.children.map(text).join('')}`; }
function fixture() {
  const document = { createElement: (tag) => new Node(tag), createTextNode: (textContent) => Object.assign(new Node('#text'), { textContent }) };
  const details = new Node('div'); const pillGroup = new Node('div'); pillGroup.className = 'pills-group';
  const trait = new Node('span'); trait.pillGroup = pillGroup; const nativePill = new Node('span'); nativePill.setAttribute('data-trait', 'weapon');
  pillGroup.append(nativePill); details.append(pillGroup);
  const element = { ownerDocument: document, querySelector: (selector) => selector === 'section[data-tab="details"] .right' ? details : null };
  const actor = { type: 'character', documentName: 'Actor', getFlag: () => ({ groups: { 'Natural Weapons': 'proficient' }, items: { 'natural-weapons/unarmed-strike': 'untrained' } }), items: [], system: { traits: { weaponProf: ['native'] } } };
  return { details, element, actor, nativePill };
}
const render = (f, equipment) => renderActorRmeProficiencies({ document: f.actor }, f.element, equipment);
const panel = (f) => f.details.querySelector('[data-rme-proficiencies]');

test('renders native-style pills, visible negative exclusions, safe labels and idempotently', () => {
  const f = fixture();
  f.actor.getFlag = () => ({ groups: { 'Natural Weapons': 'proficient' }, items: { 'natural-weapons/unarmed-strike': 'untrained', 'natural-weapons/basic': 'basic', 'natural-weapons/expert': 'expert' } });
  const equipment = [
    { id: 'natural-weapons/strike', name: 'Claws', group: 'Natural Weapons', kind: 'natural' },
    { id: 'natural-weapons/unarmed-strike', name: 'Unarmed Strike', group: 'Natural Weapons', kind: 'natural' },
    { id: 'natural-weapons/basic', name: '<Basic & safe>', group: 'Natural Weapons', kind: 'natural' },
    { id: 'natural-weapons/expert', name: 'Expert Claw', group: 'Natural Weapons', kind: 'natural' },
  ];
  render(f, equipment);
  const root = panel(f); assert.ok(root);
  assert.equal(f.details.children[1], root);
  const sections = descendants(root, 'section');
  assert.ok(sections.every((section) => section.className.includes('pills-group')));
  assert.ok(descendants(root, 'h3').some((heading) => text(heading).includes('RME WEAPONS')));
  assert.ok(descendants(root, 'ul').filter((list) => !list.className.includes('exception-list')).every((list) => list.className.includes('pills')));
  const exclusions = descendants(root, 'details').find((node) => node.className === 'rme-proficiency-exceptions');
  assert.ok(exclusions);
  assert.equal(text(descendants(exclusions, 'summary')[0]), '2 exclusions');
  assert.deepEqual(descendants(exclusions, 'li').map(text), ['<Basic & safe>: Untrained', 'Unarmed Strike: Untrained']);
  const expert = descendants(root, 'li').find((pill) => pill.className.includes('rme-proficiency-expert'));
  assert.ok(expert); assert.equal(expert.textContent, 'Expert Claw'); assert.equal(expert.title, 'Expert Claw: Expert');
  assert.equal(expert.attributes['aria-label'], 'Expert Claw: Expert');
  const proficient = descendants(root, 'li').find((pill) => pill.textContent === 'Natural Weapons');
  assert.ok(proficient); assert.ok(!proficient.className.includes('expert'));
  assert.ok(proficient.title.startsWith('Natural Weapons: Proficient'));
  assert.deepEqual(f.actor.system.traits.weaponProf, ['native']);
  render(f, equipment);
  assert.equal(f.details.children.filter((child) => child.attributes['data-rme-proficiencies'] !== undefined).length, 1);
});

test('does not disclose positive-only category exceptions when item upgrade is its own chip', () => {
  const f = fixture(); f.actor.getFlag = () => ({ groups: { Firearms: 'proficient' }, items: { 'firearms/bolt-action-rifle': 'expert' } });
  const equipment = catalog.equipment.filter((item) => item.group === 'Firearms' || item.id === 'firearms/bolt-action-rifle');
  render(f, equipment);
  const root = panel(f); const weaponSection = descendants(root, 'section').find((section) => text(section.children[0]).includes('RME WEAPONS'));
  assert.equal(descendants(weaponSection, 'details').filter((node) => node.className === 'rme-proficiency-exceptions').length, 0);
  assert.equal(descendants(weaponSection, 'li').filter((pill) => pill.textContent === 'Bolt-Action Rifle' && pill.className.includes('rme-proficiency-expert')).length, 1);
  const firearms = descendants(weaponSection, 'li').find((pill) => pill.textContent === 'Firearms');
  assert.match(firearms.title, /Bolt-Action Rifle: Expert/);
});

test('expert category tooltip names a manually proficient item as a different tier, never an upgrade', () => {
  const f = fixture(); f.actor.getFlag = () => ({ groups: { Firearms: 'expert' }, items: { 'firearms/bolt-action-rifle': 'proficient' } });
  const equipment = catalog.equipment.filter((item) => item.group === 'Firearms' || item.id === 'firearms/bolt-action-rifle');
  render(f, equipment);
  const root = panel(f); const weaponSection = descendants(root, 'section').find((section) => text(section.children[0]).includes('RME WEAPONS'));
  const firearms = descendants(weaponSection, 'li').find((pill) => pill.textContent === 'Firearms');
  assert.ok(firearms);
  assert.match(firearms.title, /Bolt-Action Rifle: Proficient/);
  assert.doesNotMatch(firearms.title, /upgrade/i);
  const rifle = descendants(weaponSection, 'li').filter((pill) => pill.textContent === 'Bolt-Action Rifle');
  assert.equal(rifle.length, 1);
  assert.ok(!rifle[0].className.includes('rme-proficiency-expert'));
  assert.equal(rifle[0].title, 'Bolt-Action Rifle: Proficient');
  assert.equal(descendants(weaponSection, 'details').filter((node) => node.className === 'rme-proficiency-exceptions').length, 0);
});

test('proficiency pills follow native dnd5e chip styling', () => {
  const css = readFileSync(new URL('../styles/rme.css', import.meta.url), 'utf8');
  const chip = css.match(/\.rme-proficiencies li\.pill \{([^}]+)\}/)?.[1] || '';
  assert.match(chip, /--pill-border/);
  assert.match(chip, /--dnd5e-background-card/);
  assert.match(chip, /border-radius:3px/);
  assert.doesNotMatch(chip, /border-radius:999px/);
  const proficiencyCss = css.slice(css.indexOf('/* Read-only actor Details pills'));
  assert.match(proficiencyCss, /\.theme-dark \.rme-proficiencies li\.pill/);
  assert.match(proficiencyCss, /\.theme-dark \.rme-proficiencies li\.rme-proficiency-expert/);
  assert.doesNotMatch(proficiencyCss, /\[data-theme="dark"\]/);
  assert.match(proficiencyCss, /\.rme-proficiencies li\.rme-proficiency-expert[^}]*background:#f2c18b[^}]*color:#321b0b/);
  assert.match(proficiencyCss, /\.theme-dark \.rme-proficiencies li\.rme-proficiency-expert[^}]*background:#6c3515[^}]*color:#fff2e5/);
});

test('ignores irrelevant actors and missing Details targets', () => {
  const f = fixture();
  renderActorRmeProficiencies({ document: { type: 'npc' } }, f.element, []);
  renderActorRmeProficiencies({ document: f.actor }, { querySelector: () => null }, []);
  assert.equal(panel(f), null);
});

test('class group stays collapsed, reports mixed tiers, uses child pills and preserves open state', () => {
  const f = fixture(); const manual = { items: { 'bows/shortbow': 'expert' } };
  f.actor.items = [{ id: 'rogue', type: 'class', name: 'Rogue', system: { classIdentifier: 'rogue', advancement: [] } }];
  f.actor.system.details = { originalClass: 'rogue' };
  f.actor.getFlag = (_scope, key) => key === 'training' ? manual : undefined;
  const renderSheet = () => render(f, catalog.equipment);
  renderSheet(); const root = panel(f);
  const weapons = descendants(root, 'section').find((section) => text(section.children[0]).includes('RME WEAPONS'));
  const group = descendants(weapons, 'details').find((node) => node.className === 'rme-proficiency-class-disclosure');
  assert.equal(group.open, undefined); assert.equal(group.getAttribute('data-class-label'), 'Rogue Weapons');
  assert.equal(text(descendants(group, 'summary')[0]).includes('Rogue Weapons'), true);
  assert.equal(text(descendants(group, 'summary')[0]).includes('Mixed tiers'), true);
  assert.ok(!text(descendants(group, 'summary')[0]).includes('Proficient'));
  assert.ok(descendants(group, 'summary')[0].title || descendants(group, 'summary')[0].attributes['aria-label'].includes('Mixed tiers'));
  const shortbow = descendants(group, 'li').find((li) => li.textContent === 'Shortbow'); assert.ok(shortbow);
  assert.equal(shortbow.title, 'Shortbow: Expert');
  group.open = true; manual.items['bows/shortbow'] = 'proficient'; renderSheet();
  const reopened = descendants(panel(f), 'details').find((node) => node.className === 'rme-proficiency-class-disclosure');
  assert.equal(reopened.open, true);
  const child = descendants(reopened, 'li').find((li) => li.textContent === 'Shortbow');
  assert.ok(!child.className.includes('rme-proficiency-expert')); assert.equal(child.title, 'Shortbow: Proficient');
});
