import test from 'node:test';
import assert from 'node:assert/strict';
import { renderActorAmmoBadges } from '../src/actor-ammo-badge.mjs';
import { readFile } from 'node:fs/promises';

const catalog = JSON.parse(await readFile(new URL('../data/catalog.json', import.meta.url), 'utf8'));
const rifle = catalog.equipment.find((entry) => entry.name === 'Bolt-Action Rifle');

function elementFor(actor, ids = ['rifle']) {
  const rows = ids.map((id) => {
    const badges = [];
    const name = { append(node) { badges.push(node); node.parent = name; }, children: badges };
    const row = {
      dataset: { itemId: id }, badges,
      querySelector(selector) { if (selector === '[data-rme-magazine-badge]') return badges[0] || null; if (selector === '.item-name .name' || selector === '.item-name') return name; return null; },
    };
    return row;
  });
  return { rows, querySelectorAll() { return rows; } };
}

function mockDocument() {
  return { createElement() { return { dataset: {}, attributes: {}, setAttribute(k, v) { this.attributes[k] = v; }, remove() { this.removed = true; } }; } };
}

function makeActor(weapon) {
  const items = [weapon];
  return { documentName: 'Actor', items: { get(id) { return items.find((item) => item._id === id); }, [Symbol.iterator]: () => items[Symbol.iterator]() }, getFlag() { return {}; }, system: { details: {} } };
}

test('updates a magazine badge on repeated renders without touching native uses', () => {
  const oldDocument = globalThis.document;
  globalThis.document = mockDocument();
  try {
    const weapon = { _id: 'rifle', type: 'weapon', flags: { 'foundry-rme': { catalogId: rifle.id, ammunition: { loaded: 0, loadedAmmoId: 'rifle/rifle-cartridge' } } }, system: { uses: { value: 7, max: 9 } } };
    const actor = makeActor(weapon), element = elementFor(actor);
    renderActorAmmoBadges({ document: actor }, element, catalog.equipment);
    const badge = element.rows[0].badges[0];
    assert.equal(badge.textContent, '0/4');
    weapon.flags['foundry-rme'].ammunition.loaded = 3;
    renderActorAmmoBadges({ document: actor }, element, catalog.equipment);
    assert.equal(element.rows[0].badges.length, 1);
    assert.equal(badge.textContent, '3/4');
    assert.equal(badge.attributes['aria-label'], 'RME loaded ammunition: 3 of 4 (rifle/rifle-cartridge)');
    assert.deepEqual(weapon.system.uses, { value: 7, max: 9 });
  } finally { globalThis.document = oldDocument; }
});

test('ignores non-magazines, unmarked items, missing rows, and removes badges when capacity drops to zero', () => {
  const oldDocument = globalThis.document;
  globalThis.document = mockDocument();
  try {
    const weapon = { _id: 'rifle', type: 'weapon', flags: { 'foundry-rme': { catalogId: rifle.id, ammunition: { loaded: 1 } } }, system: {} };
    const actor = makeActor(weapon), element = elementFor(actor);
    renderActorAmmoBadges({ document: actor }, element, catalog.equipment);
    assert.equal(element.rows[0].badges[0].textContent, '1/4');
    const cannon = catalog.equipment.find((entry) => entry.name === 'Hand Cannon');
    weapon.flags['foundry-rme'].catalogId = cannon.id;
    weapon.flags['foundry-rme'].training = { items: { [cannon.id]: 'expert' } };
    actor.getFlag = (scope, key) => key === 'training' ? weapon.flags['foundry-rme'].training : {};
    renderActorAmmoBadges({ document: actor }, element, catalog.equipment);
    assert.equal(element.rows[0].badges[0].removed, true);
    const noRme = makeActor({ _id: 'plain', type: 'weapon', flags: {}, system: {} });
    renderActorAmmoBadges({ document: noRme }, elementFor(noRme), catalog.equipment);
    renderActorAmmoBadges({ document: actor }, { querySelectorAll: () => [] }, catalog.equipment);
    renderActorAmmoBadges({ document: { documentName: 'Item' } }, element, catalog.equipment);
  } finally { globalThis.document = oldDocument; }
});
