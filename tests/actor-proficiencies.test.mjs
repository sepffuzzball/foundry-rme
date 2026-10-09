import test from 'node:test';
import assert from 'node:assert/strict';
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
    const all=descendants(this,'*');
    if(selector==='details[open] > summary') return all.filter((node)=>node.tagName==='details'&&node.open).flatMap((node)=>node.children.filter((child)=>child.tagName==='summary'));
    if(selector==='details.rme-proficiency-class-disclosure') return all.filter((node)=>node.tagName==='details'&&node.className==='rme-proficiency-class-disclosure');
    if(selector==='details.rme-proficiency-class-disclosure[open]') return all.filter((node)=>node.tagName==='details'&&node.className==='rme-proficiency-class-disclosure'&&node.open);
    return [];
  }
  get firstElementChild() { return this.children[0] || null; }
}

function descendants(node, tag) {
  return node.children.flatMap((child) => [ ...(tag === '*' || child.tagName === tag ? [child] : []), ...descendants(child, tag) ]);
}

function fixture() {
  const document = { createElement: (tag) => new Node(tag) };
  const details = new Node('div');
  const pillGroup = new Node('div'); pillGroup.className = 'pills-group';
  const trait = new Node('span'); trait.pillGroup = pillGroup;
  details.weaponTrait = trait;
  const nativePill = new Node('span'); nativePill.setAttribute('data-trait', 'weapon');
  pillGroup.append(nativePill); details.append(pillGroup);
  const element = { ownerDocument: document, querySelector: (selector) => selector === 'section[data-tab="details"] .right' ? details : null };
  const actor = { type: 'character', documentName: 'Actor', getFlag: () => ({ groups: { 'Natural Weapons': 'proficient' }, items: { 'natural-weapons/unarmed-strike': 'untrained' } }), items: [], system: { traits: { weaponProf: ['native'] } } };
  return { document, details, element, actor, nativePill };
}

test('renders accessible exception disclosure and positive exception rows idempotently', () => {
  const f = fixture();
  f.actor.getFlag = () => ({ groups: { 'Natural Weapons': 'proficient' }, items: { 'natural-weapons/unarmed-strike': 'untrained', 'natural-weapons/basic': 'basic', 'natural-weapons/expert': 'expert' } });
  const equipment = [
    { id: 'natural-weapons/strike', name: 'Claws', group: 'Natural Weapons', kind: 'natural' },
    { id: 'natural-weapons/unarmed-strike', name: 'Unarmed Strike', group: 'Natural Weapons', kind: 'natural' },
    { id: 'natural-weapons/basic', name: '<Basic & safe>', group: 'Natural Weapons', kind: 'natural' },
    { id: 'natural-weapons/expert', name: 'Expert Claw', group: 'Natural Weapons', kind: 'natural' },
  ];
  renderActorRmeProficiencies({ document: f.actor }, f.element, equipment);
  const panel = f.details.querySelector('[data-rme-proficiencies]');
  assert.ok(panel);
  assert.equal(f.details.children[1], panel);
  assert.equal(f.nativePill.getAttribute('data-trait'), 'weapon');
  assert.deepEqual(f.actor.system.traits.weaponProf, ['native']);
  const category = panel.children[0].children[1].children[0];
  assert.equal(category.attributes['aria-label'], undefined);
  const disclosure = descendants(category, 'details')[0];
  assert.equal(disclosure.className, 'rme-proficiency-exceptions');
  const summary = descendants(disclosure, 'summary')[0];
  assert.equal(summary.textContent, '3 exceptions');
  const listed = descendants(disclosure, 'li').map((entry) => entry.textContent);
  assert.deepEqual(listed, ['<Basic & safe>: Untrained', 'Expert Claw: Expert', 'Unarmed Strike: Untrained']);
  const expert = descendants(panel, 'span').find((badge) => badge.className.includes('rme-proficiency-expert'));
  assert.ok(expert);
  assert.equal(expert.textContent, 'Expert');
  renderActorRmeProficiencies({ document: f.actor }, f.element, equipment);
  assert.equal(f.details.children.filter((child) => child.attributes['data-rme-proficiencies'] !== undefined).length, 1);
});

test('ignores irrelevant actors and missing Details targets', () => {
  const f = fixture();
  renderActorRmeProficiencies({ document: { type: 'npc' } }, f.element, []);
  renderActorRmeProficiencies({ document: f.actor }, { querySelector: () => null }, []);
  assert.equal(f.details.querySelector('[data-rme-proficiencies]'), null);
});

test('Rogue class grants are collapsed after catalog categories and before standalone items, with refreshed tiers and open state', () => {
  const f = fixture();
  const manual = { items: { 'firearms/bolt-action-rifle': 'proficient' } };
  f.actor.items = [{ id: 'rogue', type: 'class', name: 'Rogue', system: { classIdentifier: 'rogue', advancement: [] } }];
  f.actor.system.details = { originalClass: 'rogue' };
  f.actor.getFlag = (_scope, key) => key === 'training' ? manual : undefined;
  const render = () => renderActorRmeProficiencies({ document: f.actor }, f.element, catalog.equipment);
  render();
  const panel = f.details.querySelector('[data-rme-proficiencies]');
  const sections = panel.children;
  const weapons = sections.find((node) => node.children[0].textContent === 'RME Weapons');
  const rows = weapons.children[1].children;
  const classRow = rows.find((node) => descendants(node, 'details').some((d) => d.className === 'rme-proficiency-class-disclosure'));
  const group = descendants(classRow, 'details')[0];
  assert.equal(group.open, undefined);
  assert.equal(group.getAttribute('data-class-label'), 'Rogue Weapons');
  assert.equal(descendants(group, 'summary')[0].children[0].textContent, 'Rogue Weapons');
  assert.ok(rows.indexOf(classRow) > rows.findLastIndex((node) => node.children[0]?.textContent === 'Natural Weapons'));
  assert.equal(rows.at(-1).children[0].textContent, 'Bolt-Action Rifle');
  const shortbow = descendants(group, 'li').find((li) => li.children[0]?.textContent === 'Shortbow');
  assert.ok(shortbow);
  assert.equal(shortbow.children[1].textContent, 'Proficient');
  const oldCount = descendants(group, 'summary')[0].children.at(-1).textContent;
  group.open = true;
  manual.items['bows/shortbow'] = 'expert';
  render();
  const updated = descendants(panel, 'details').find((d) => d.className === 'rme-proficiency-class-disclosure');
  assert.equal(updated.open, true);
  assert.equal(descendants(updated, 'summary')[0].children.at(-1).textContent, oldCount);
  assert.equal(descendants(updated, 'summary')[0].children[1].textContent, 'Mixed tiers');
  assert.equal(descendants(updated, 'li').find((li) => li.children[0]?.textContent === 'Shortbow').children[1].textContent, 'Expert');
  manual.items['bows/shortbow'] = 'untrained';
  render();
  const reduced = descendants(panel, 'details').find((d) => d.className === 'rme-proficiency-class-disclosure');
  assert.equal(reduced.open, true);
  assert.notEqual(descendants(reduced, 'summary')[0].children.at(-1).textContent, oldCount);
  assert.equal(descendants(reduced, 'li').some((li) => li.children[0]?.textContent === 'Shortbow'), false);
  assert.equal(descendants(panel, 'details').filter((d) => d.className === 'rme-proficiency-class-disclosure').length, 1);
});
