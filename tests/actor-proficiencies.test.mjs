import test from 'node:test';
import assert from 'node:assert/strict';
import { renderActorRmeProficiencies } from '../src/actor-proficiencies.mjs';

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
  get firstElementChild() { return this.children[0] || null; }
}

function descendants(node, tag) {
  return node.children.flatMap((child) => [ ...(child.tagName === tag ? [child] : []), ...descendants(child, tag) ]);
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
