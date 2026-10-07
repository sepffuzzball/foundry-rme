import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
globalThis.Hooks = { once() {}, on() {} };
const { applyClassGrantSelections, replaceTrainingFlag } = await import('../src/main.mjs');

test('module manifest targets Foundry 14 and dnd5e 6', async () => {
  const manifest = JSON.parse(await readFile(new URL('../module.json', import.meta.url)));
  assert.equal(manifest.id, 'foundry-rme');
  assert.equal(manifest.compatibility.minimum, '14.367');
  assert.equal(manifest.compatibility.verified, '14.368');
  assert.ok(manifest.relationships.systems.some((s) => s.id === 'dnd5e' && s.compatibility.minimum === '6.0.6'));
});

test('runtime exposes service methods and escapes catalog-facing content', async () => {
  const source = await readFile(new URL('../src/main.mjs', import.meta.url), 'utf8');
  for (const name of ['openCatalog', 'openTraining', 'importCatalog', 'syncActorItems']) assert.match(source, new RegExp(`\\b${name}\\b`));
  assert.match(source, /replace\(\/\[&<>"'\]\/g/);
  assert.match(source, /<pre class="rme-source">\$\{esc\(/);
});

test('runtime uses v14 DialogV2 and exposes actor-sheet catalog access without a console', async () => {
  const source = await readFile(new URL('../src/main.mjs', import.meta.url), 'utf8');
  assert.match(source, /foundry\.applications\.api\.DialogV2/);
  assert.match(source, /dialog\.render\(true\)/);
  assert.match(source, /dlg\.render\(true\)/);
  assert.doesNotMatch(source, /render:\s*\(/);
  assert.match(source, /action:'rme-training',label:'RME Training',icon:/);
  assert.match(source, /action:'rme-catalog',label:'RME Catalog',icon:/);
  assert.match(source, /data-rme-import-all/);
  assert.match(source, /data-rme-import-actor/);
});

test('training dialog offers opt-in class starting-training seeding', async () => {
  const source = await readFile(new URL('../src/main.mjs', import.meta.url), 'utf8');
  assert.match(source, /CLASS_IDS, eligibleGroups, classGrants/);
  assert.match(source, /data-rme-apply-class/);
  assert.match(source, /classGrants\(id,data\.equipment,chosen,\{seed:isChoice\}\)/);
  assert.match(source, /await dlg\.render\(true\);[\s\S]*?addEventListener\('click'/);
});

test('training flag replacement removes old nested keys when clearing state', async () => {
  const calls = [];
  const actor = { unsetFlag: async (...args) => calls.push(['unset', ...args]), setFlag: async (...args) => calls.push(['set', ...args]) };
  await replaceTrainingFlag(actor, { groups: { Swords: 'expert' }, items: { sword: 'expert' } }, {});
  assert.deepEqual(calls, [['unset', 'foundry-rme', 'training']]);
});

test('class grants preserve expert and explicit item settings and avoid redundant group item overrides', () => {
  const entries = [{ id: 'a', group: 'Swords' }, { id: 'b', group: 'Swords' }, { id: 'c', group: 'Axes' }];
  const result = applyClassGrantSelections({ groups: { Swords: 'expert' }, items: { b: 'untrained' } }, {
    groups: { Swords: 'proficient', Axes: 'proficient' }, items: { a: 'proficient', b: 'proficient', c: 'proficient' },
  }, entries);
  assert.deepEqual(result, { groups: { Swords: 'expert', Axes: 'proficient' }, items: { b: 'untrained' } });
});
