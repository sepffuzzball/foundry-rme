import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { deriveActorTraining } from '../src/derive-training.mjs';
import { eligibleGroups } from '../src/class-training.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const catalog = JSON.parse(
  readFileSync(join(__dirname, '..', 'data', 'catalog.json'), 'utf8')
);
const equipment = catalog.equipment;

const EIGHT = [
  'Axes',
  'Bows',
  'Combat Blades',
  'Dueling Blades',
  'Flails',
  'Hammers Picks',
  'Spears',
  'Whips',
];
const FOUR = ['Axes', 'Bows', 'Combat Blades', 'Dueling Blades'];

// --- mock item / actor builders -------------------------------------------

function classItem(id, name, classIdentifier, advancement = [], levels) {
  const system = { classIdentifier, advancement };
  if (levels !== undefined) system.levels = levels;
  return { id, type: 'class', name, system };
}

function raceItem(id, name, advancement) {
  return { id, type: 'race', name, system: { identifier: name.toLowerCase(), advancement } };
}

function featItem(id, name, advancement = []) {
  return { id, type: 'feat', name, system: { identifier: id, advancement } };
}

function subclassItem(id, name, advancement = []) {
  return { id, type: 'subclass', name, system: { identifier: id, advancement } };
}

function traitAdvancement({
  grants = [],
  chosen = [],
  choices = null,
  type = 'Traits',
  level = undefined,
  classRestriction = undefined,
} = {}) {
  const configuration = { grants };
  if (choices) configuration.choices = choices;
  const entry = { _id: 't1', type, configuration, value: { chosen } };
  if (level !== undefined) entry.level = level;
  if (classRestriction !== undefined) entry.classRestriction = classRestriction;
  return entry;
}

function actorWith(items, { originalClass = null } = {}) {
  return { system: { details: { originalClass } }, items };
}

function derive(items, choices = {}, options = {}) {
  const actor = actorWith(items, options);
  return deriveActorTraining(actor, equipment, choices);
}

// ---------------------------------------------------------------------------
// Core provenance: two independent non-multiclass sources promote to expert
// ---------------------------------------------------------------------------

test('Fighter + Dwarf matching battleaxe grants expert (group expansion overlaps)', () => {
  const fighterId = 'cls-fighter';
  const result = derive(
    [
      classItem(fighterId, 'Fighter', 'fighter'),
      raceItem('race-dwarf', 'Dwarf', [traitAdvancement({ grants: ['weapon:battle-axe'] })]),
    ],
    { [fighterId]: { groups: EIGHT } },
    { originalClass: fighterId }
  );

  // Fighter's Axes group grant is expanded; Dwarf's individual battle-axe grant
  // overlaps it, so two non-multiclass sources are proficient -> expert.
  assert.equal(result.training.groups['Axes'], 'proficient');
  assert.equal(result.training.items['axes/battle-axe'], 'expert');
  // Other axes only have the group source and are not emitted individually.
  assert.ok(!('axes/broadaxe' in result.training.items));
  assert.ok(!('axes/greataxe' in result.training.items));
  assert.deepEqual(result.gaps, []);
  assert.deepEqual(result.sources.map((s) => s.type), ['class', 'race']);
  assert.equal(result.sources[0].id, fighterId);
  assert.equal(result.sources[1].id, 'race-dwarf');
});

test('Fighter + Barbarian multiclass stays proficient (two classes never promote)', () => {
  const fighterId = 'cls-fighter';
  const barbId = 'cls-barbarian';
  const result = derive(
    [classItem(fighterId, 'Fighter', 'fighter'), classItem(barbId, 'Barbarian', 'barbarian')],
    {
      [fighterId]: { groups: EIGHT },
      [barbId]: { groups: FOUR },
    },
    { originalClass: fighterId }
  );

  assert.equal(result.training.groups['Axes'], 'proficient');
  assert.notEqual(result.training.items['axes/battle-axe'], 'expert');
  assert.deepEqual(result.gaps, []);
});

test('Multiclass barbarian receives simple weapons and shields, not heavy armor', () => {
  const fighterId = 'cls-fighter';
  const barbId = 'cls-barbarian';
  const result = derive(
    [classItem(fighterId, 'Fighter', 'fighter'), classItem(barbId, 'Barbarian', 'barbarian')],
    {
      [fighterId]: { groups: EIGHT },
      [barbId]: { groups: FOUR },
    },
    { originalClass: fighterId }
  );

  const barbSource = result.sources.find((s) => s.id === barbId);
  assert.ok(barbSource, 'expected a barbarian source');
  assert.equal(barbSource.grants.items['dueling-blades/dagger'], 'proficient');
  assert.equal(barbSource.grants.items['shields/skirmish'], 'proficient');
  // The multiclass barbarian grants no heavy armor (that is the fighter's).
  assert.ok(!('armor/plate' in barbSource.grants.items));
  assert.equal(result.training.items['dueling-blades/dagger'], 'proficient');
  assert.equal(result.training.items['armor/padded'], 'proficient');
});

// ---------------------------------------------------------------------------
// Category choice selection: 8 for original, 4 for multiclass
// ---------------------------------------------------------------------------

test('providing 8 original / 4 multiclass categories is applied without gaps', () => {
  const fighterId = 'cls-fighter';
  const barbId = 'cls-barbarian';
  const result = derive(
    [classItem(fighterId, 'Fighter', 'fighter'), classItem(barbId, 'Barbarian', 'barbarian')],
    {
      [fighterId]: { groups: EIGHT },
      [barbId]: { groups: FOUR },
    },
    { originalClass: fighterId }
  );

  for (const group of EIGHT) assert.equal(result.training.groups[group], 'proficient');
  for (const group of FOUR) assert.equal(result.training.groups[group], 'proficient');
  assert.deepEqual(result.gaps, []);
});

test('missing original 8-category choice reports a groups gap with options', () => {
  const fighterId = 'cls-fighter';
  const result = derive(
    [classItem(fighterId, 'Fighter', 'fighter')],
    {},
    { originalClass: fighterId }
  );

  const gap = result.gaps.find((g) => g.sourceId === fighterId);
  assert.ok(gap, 'expected a groups gap for the fighter');
  assert.equal(gap.type, 'groups');
  assert.equal(gap.count, 8);
  assert.ok(Array.isArray(gap.options) && gap.options.includes('Axes'));
  assert.ok(!gap.options.includes('Natural Weapons'));
  // The fixed armor/simple grants are still produced without guessing groups.
  assert.equal(result.training.items['armor/plate'], 'proficient');
});

test('missing multiclass 4-category choice reports a groups gap with options', () => {
  const fighterId = 'cls-fighter';
  const barbId = 'cls-barbarian';
  const result = derive(
    [classItem(fighterId, 'Fighter', 'fighter'), classItem(barbId, 'Barbarian', 'barbarian')],
    { [fighterId]: { groups: EIGHT } },
    { originalClass: fighterId }
  );

  const gap = result.gaps.find((g) => g.sourceId === barbId);
  assert.ok(gap, 'expected a groups gap for the multiclass barbarian');
  assert.equal(gap.type, 'groups');
  assert.equal(gap.count, 4);
  assert.deepEqual(gap.options, [
    ...new Set(
      ['Ambush Weapons', 'Axes', 'Bludgeons', 'Bows', 'Combat Blades', 'Dueling Blades',
        'Flails', 'Hammers Picks', 'Launch Weapons', 'Polearms', 'Spears',
        'Throwing Weapons', 'Whips']
    ),
  ]);
  // Multiclass barbarian grants shields and simple weapons even without choices.
  assert.equal(result.training.items['dueling-blades/dagger'], 'proficient');
});

// ---------------------------------------------------------------------------
// Removal recomputes (purity / determinism)
// ---------------------------------------------------------------------------

test('removing the dwarf race recomputes battleaxe as non-expert', () => {
  const fighterId = 'cls-fighter';
  const withDwarf = derive(
    [
      classItem(fighterId, 'Fighter', 'fighter'),
      raceItem('race-dwarf', 'Dwarf', [traitAdvancement({ grants: ['weapon:battle-axe'] })]),
    ],
    { [fighterId]: { groups: EIGHT } },
    { originalClass: fighterId }
  );
  assert.equal(withDwarf.training.items['axes/battle-axe'], 'expert');

  const withoutDwarf = derive(
    [classItem(fighterId, 'Fighter', 'fighter')],
    { [fighterId]: { groups: EIGHT } },
    { originalClass: fighterId }
  );
  // The explicit item disappears; battleaxe resolves via the Axes group.
  assert.ok(!('axes/battle-axe' in withoutDwarf.training.items));
  assert.equal(withoutDwarf.training.groups['Axes'], 'proficient');
});

test('deriveActorTraining does not mutate any input', () => {
  const fighterId = 'cls-fighter';
  const frozenGroups = Object.freeze([...EIGHT]);
  const frozenChoices = Object.freeze({ [fighterId]: Object.freeze({ groups: frozenGroups }) });
  const frozenEquipment = Object.freeze([...equipment]);

  const actor = { system: { details: { originalClass: fighterId } }, items: Object.freeze([
    Object.freeze({ id: fighterId, type: 'class', name: 'Fighter', system: Object.freeze({ classIdentifier: 'fighter', advancement: Object.freeze([]) }) }),
    Object.freeze({ id: 'race-dwarf', type: 'race', name: 'Dwarf', system: Object.freeze({ identifier: 'dwarf', advancement: Object.freeze([Object.freeze({ _id: 't1', type: 'Traits', configuration: Object.freeze({ grants: ['weapon:battle-axe'] }), value: Object.freeze({ chosen: [] }) })]) }) }),
  ]) };

  deriveActorTraining(actor, frozenEquipment, frozenChoices);

  assert.equal(actor.system.details.originalClass, fighterId);
  assert.equal(actor.items[1].system.advancement[0].value.chosen.length, 0);
  assert.equal(frozenEquipment.length, equipment.length);
  assert.equal(frozenChoices[fighterId].groups.length, 8);
});

// ---------------------------------------------------------------------------
// Race / feat Trait choices
// ---------------------------------------------------------------------------

test('a feat Trait weapon choice grants the chosen weapon', () => {
  const featId = 'feat-training';
  const chosen = ['weapon:shortbow'];
  const result = derive([
    featItem(featId, 'Weapon Training', [
      traitAdvancement({ grants: [], chosen, choices: { weapons: ['weapon:shortbow', 'weapon:battle-axe'] } }),
    ]),
  ]);

  assert.equal(result.training.items['bows/shortbow'], 'proficient');
  assert.deepEqual(result.gaps, []);
});

test('an unselected Trait weapon pool reports a gap and grants nothing', () => {
  const featId = 'feat-training';
  const result = derive([
    featItem(featId, 'Weapon Training', [
      traitAdvancement({ grants: [], chosen: [], choices: { weapons: ['weapon:shortbow', 'weapon:battle-axe'] } }),
    ]),
  ]);

  const gap = result.gaps.find((g) => g.sourceId === featId);
  assert.ok(gap, 'expected an unselected pool gap');
  assert.equal(gap.type, 'choices');
  assert.deepEqual(Object.keys(result.training.items), []);
  assert.deepEqual(Object.keys(result.training.groups), []);
});

test('armor:lgt / armor:shl trait keys grant light armor and shields', () => {
  const raceId = 'race-armored';
  const result = derive([
    raceItem(raceId, 'Armoredfolk', [
      traitAdvancement({ grants: ['armor:lgt', 'armor:shl'] }),
    ]),
  ]);

  assert.equal(result.training.items['armor/padded'], 'proficient');
  assert.equal(result.training.items['armor/leather'], 'proficient');
  assert.ok(!('armor/chain-shirt' in result.training.items));
  assert.equal(result.training.items['shields/buckler'], 'proficient');
  assert.deepEqual(result.gaps, []);
});

// ---------------------------------------------------------------------------
// Unknown keys produce gaps rather than silent martial grants
// ---------------------------------------------------------------------------

test('an unknown weapon trait key reports a gap and grants nothing', () => {
  const raceId = 'race-unknown';
  const result = derive([
    raceItem(raceId, 'Unknownfolk', [traitAdvancement({ grants: ['weapon:zap'] })]),
  ]);

  const gap = result.gaps.find((g) => g.sourceId === raceId);
  assert.ok(gap);
  assert.equal(gap.type, 'weapon');
  assert.match(gap.reason, /Unknown weapon trait key/);
  assert.deepEqual(Object.keys(result.training.items), []);
});

test('weapon:mar reports a gap and never auto-grants a martial group', () => {
  const raceId = 'race-mar';
  const result = derive([
    raceItem(raceId, 'Marfolk', [traitAdvancement({ grants: ['weapon:mar'] })]),
  ]);

  const gap = result.gaps.find((g) => g.sourceId === raceId);
  assert.ok(gap);
  assert.equal(gap.type, 'weapon');
  assert.match(gap.reason, /weapon:mar/);
  assert.deepEqual(result.training.groups, {});
  assert.deepEqual(Object.keys(result.training.items), []);
});

test('unknown armor trait key reports a gap', () => {
  const raceId = 'race-armor';
  const result = derive([
    raceItem(raceId, 'Armorfaux', [traitAdvancement({ grants: ['armor:xyz'] })]),
  ]);

  const gap = result.gaps.find((g) => g.sourceId === raceId);
  assert.ok(gap);
  assert.equal(gap.type, 'armor');
});

test('a non-armor/weapon trait key is ignored without a gap', () => {
  const raceId = 'race-tool';
  const result = derive([
    raceItem(raceId, 'Toolfolk', [traitAdvancement({ grants: ['tool:smith', 'weapon:battle-axe'] })]),
  ]);

  assert.equal(result.training.items['axes/battle-axe'], 'proficient');
  assert.deepEqual(result.gaps, []);
});

test('a trait weapon key resolves a natural weapon by catalog slug', () => {
  const raceId = 'race-natural';
  const result = derive([
    raceItem(raceId, 'Beastfolk', [traitAdvancement({ grants: ['weapon:natural-weapons/bite'] })]),
  ]);
  assert.equal(result.training.items['natural-weapons/bite'], 'proficient');
  assert.deepEqual(result.gaps, []);
});

test('a trait weapon key resolves a natural weapon by name', () => {
  const raceId = 'race-natural-name';
  const result = derive([
    raceItem(raceId, 'Beastfolk', [traitAdvancement({ grants: ['weapon:bite'] })]),
  ]);
  assert.equal(result.training.items['natural-weapons/bite'], 'proficient');
  assert.deepEqual(result.gaps, []);
});

// ---------------------------------------------------------------------------
// Subclass expert training
// ---------------------------------------------------------------------------

test('Arcane Archer grants Bows and Crossbows as expert', () => {
  const result = derive([subclassItem('sub-aa', 'Arcane Archer')]);
  assert.equal(result.training.groups['Bows'], 'expert');
  assert.equal(result.training.groups['Crossbows'], 'expert');
  assert.deepEqual(result.gaps, []);
});

test('Path of the Beast grants Bite, Claw and Tail expert', () => {
  const result = derive([subclassItem('sub-beast', 'Path of the Beast')]);
  assert.equal(result.training.items['natural-weapons/bite'], 'expert');
  assert.equal(result.training.items['natural-weapons/claw'], 'expert');
  assert.equal(result.training.items['natural-weapons/tail'], 'expert');
  assert.deepEqual(result.gaps, []);
});

test('Cavalier grants the Lance expert', () => {
  const result = derive([subclassItem('sub-cav', 'Cavalier')]);
  assert.equal(result.training.items['spears/lance'], 'expert');
  assert.deepEqual(result.gaps, []);
});

test('Circle of the Moon grants every natural weapon except unarmed strike', () => {
  const result = derive([subclassItem('sub-moon', 'Circle of the Moon')]);
  const natural = Object.keys(result.training.items).filter((id) => id.startsWith('natural-weapons/'));
  assert.equal(natural.length, 7);
  assert.ok(!('natural-weapons/unarmed-strike' in result.training.items));
  assert.ok(natural.includes('natural-weapons/bite'));
  assert.ok(natural.includes('natural-weapons/tail'));
  assert.deepEqual(result.gaps, []);
});

test('Armorer grants heavy armor expert and requires a shield choice', () => {
  const armorerId = 'sub-armorer';
  const result = derive(
    [subclassItem(armorerId, 'Armorer')],
    { [armorerId]: { items: ['shields/buckler'] } }
  );
  assert.equal(result.training.items['armor/hauberk'], 'expert');
  assert.equal(result.training.items['armor/plate'], 'expert');
  assert.equal(result.training.items['shields/buckler'], 'expert');
  assert.deepEqual(result.gaps, []);
});

test('Armorer with no shield choice reports a gap and still grants heavy armor', () => {
  const armorerId = 'sub-armorer';
  const result = derive([subclassItem(armorerId, 'Armorer')]);
  const gap = result.gaps.find((g) => g.sourceId === armorerId);
  assert.ok(gap);
  assert.equal(gap.type, 'choices');
  assert.equal(result.training.items['armor/hauberk'], 'expert');
});

test('Bladesinger requires a one-handed melee weapon choice', () => {
  const bs = 'sub-bs';
  const missing = derive([subclassItem(bs, 'Bladesinger')]);
  assert.ok(missing.gaps.some((g) => g.sourceId === bs && g.type === 'choices'));

  const chosen = derive(
    [subclassItem(bs, 'Bladesinger')],
    { [bs]: { items: ['dueling-blades/rapier'] } }
  );
  assert.equal(chosen.training.items['dueling-blades/rapier'], 'expert');
  assert.deepEqual(chosen.gaps, []);

  // A two-handed weapon is not one-handed and is rejected.
  const bad = derive([subclassItem(bs, 'Bladesinger')], { [bs]: { items: ['bludgeons/quarterstaff'] } });
  assert.ok(bad.gaps.some((g) => g.sourceId === bs && g.type === 'choices'));
});

test('College of Swords requires a one-handed Combat Blade choice', () => {
  const cs = 'sub-cs';
  const chosen = derive(
    [subclassItem(cs, 'College of Swords')],
    { [cs]: { items: ['combat-blades/scimitar'] } }
  );
  assert.equal(chosen.training.items['combat-blades/scimitar'], 'expert');
  assert.deepEqual(chosen.gaps, []);

  // A two-handed Combat Blade (greatsword) is not a valid option.
  const bad = derive(
    [subclassItem(cs, 'College of Swords')],
    { [cs]: { items: ['combat-blades/greatsword'] } }
  );
  assert.ok(bad.gaps.some((g) => g.sourceId === cs && g.type === 'choices'));
});

test('Pact of the Blade requires a simple weapon choice', () => {
  const pb = 'sub-pb';
  const chosen = derive(
    [subclassItem(pb, 'Pact of the Blade')],
    { [pb]: { items: ['dueling-blades/dagger'] } }
  );
  assert.equal(chosen.training.items['dueling-blades/dagger'], 'expert');
  assert.deepEqual(chosen.gaps, []);

  // battle-axe is martial, so it is not allowed for the pact weapon.
  const bad = derive([subclassItem(pb, 'Pact of the Blade')], { [pb]: { items: ['axes/battle-axe'] } });
  assert.ok(bad.gaps.some((g) => g.sourceId === pb && g.type === 'choices'));
});

test('Way of the Kensei requires selected weapons and reports a gap when missing', () => {
  const kn = 'sub-kn';
  const missing = derive([subclassItem(kn, 'Way of the Kensei')]);
  assert.ok(missing.gaps.some((g) => g.sourceId === kn && g.type === 'choices'));

  const chosen = derive(
    [subclassItem(kn, 'Way of the Kensei')],
    { [kn]: { items: ['axes/battle-axe', 'bows/shortbow'] } }
  );
  assert.equal(chosen.training.items['axes/battle-axe'], 'expert');
  assert.equal(chosen.training.items['bows/shortbow'], 'expert');
  assert.deepEqual(chosen.gaps, []);
});

test('Way of the Open Hand requires a natural weapon choice', () => {
  const oh = 'sub-oh';
  const chosen = derive(
    [subclassItem(oh, 'Way of the Open Hand')],
    { [oh]: { items: ['natural-weapons/bite'] } }
  );
  assert.equal(chosen.training.items['natural-weapons/bite'], 'expert');
  assert.deepEqual(chosen.gaps, []);

  // A plain weapon is not a natural weapon.
  const bad = derive([subclassItem(oh, 'Way of the Open Hand')], { [oh]: { items: ['axes/battle-axe'] } });
  assert.ok(bad.gaps.some((g) => g.sourceId === oh && g.type === 'choices'));
});

test('an unknown subclass grants nothing and no gap (no guess)', () => {
  const result = derive([subclassItem('sub-rune', 'Rune Knight')]);
  assert.deepEqual(Object.keys(result.training.groups), []);
  assert.deepEqual(Object.keys(result.training.items), []);
  assert.deepEqual(result.gaps, []);
  assert.deepEqual(result.sources, []);
});

// ---------------------------------------------------------------------------
// Subclass generic martial proficiency (weapon:mar) prompts for 8 categories
// ---------------------------------------------------------------------------

test('a subclass martial Trait grant with no category choice reports an 8-category gap', () => {
  const id = 'sub-custom-mar';
  const result = derive([
    subclassItem(id, 'Custom Blade', [
      traitAdvancement({ type: 'Trait', grants: ['weapon:mar'] }),
    ]),
  ]);

  const gap = result.gaps.find((g) => g.sourceId === id);
  assert.ok(gap, 'expected a gap for the martial subclass');
  assert.equal(gap.type, 'groups');
  assert.equal(gap.count, 8);
  assert.equal(gap.reason, 'Subclass martial proficiency requires 8 RME category choices');
  assert.deepEqual(gap.options, eligibleGroups('fighter', equipment));
  // The generic unknown-weapon gap must be suppressed for a martial subclass.
  assert.ok(!result.gaps.some((g) => g.type === 'weapon'));
  // No fixed grants to produce, so no provider source is emitted.
  assert.deepEqual(result.sources, []);
});

test('a subclass martial Trait grant with 8 selected categories applies the grants', () => {
  const id = 'sub-custom-mar';
  const result = derive(
    [subclassItem(id, 'Custom Blade', [
      traitAdvancement({ type: 'Trait', grants: ['weapon:mar'] }),
    ])],
    { [id]: { groups: EIGHT } }
  );

  for (const group of EIGHT) assert.equal(result.training.groups[group], 'proficient');
  assert.deepEqual(result.gaps, []);
  // One provider contributes exactly one merged source.
  assert.equal(result.sources.length, 1);
});

test('a subclass martial Trait grant with a partial category choice applies valid groups and still gaps', () => {
  const id = 'sub-custom-mar';
  const result = derive(
    [subclassItem(id, 'Custom Blade', [
      traitAdvancement({ type: 'Trait', grants: ['weapon:mar'] }),
    ])],
    { [id]: { groups: ['Axes', 'Bows'] } }
  );

  const gap = result.gaps.find((g) => g.sourceId === id && g.type === 'groups');
  assert.ok(gap, 'expected a groups gap for the partial choice');
  assert.equal(gap.count, 8);
  // The valid partial grants are applied; the missing categories are not guessed.
  assert.equal(result.training.groups['Axes'], 'proficient');
  assert.equal(result.training.groups['Bows'], 'proficient');
  assert.ok(!('Crossbows' in result.training.groups));
});

test('a subclass martial Trait grant rejects unknown and duplicate categories with a single gap', () => {
  const id = 'sub-custom-mar';
  const result = derive(
    [subclassItem(id, 'Custom Blade', [
      traitAdvancement({ type: 'Trait', grants: ['weapon:mar'] }),
    ])],
    { [id]: { groups: ['Axes', 'Bows', 'Flails', 'Not-a-group', 'Axes'] } }
  );

  const groupsGaps = result.gaps.filter((g) => g.sourceId === id && g.type === 'groups');
  // Exactly one groups gap, even though there are unknown and duplicate entries.
  assert.equal(groupsGaps.length, 1);
  assert.equal(groupsGaps[0].count, 8);
  // Unknown / duplicate entries are rejected; the valid ones are applied.
  assert.equal(result.training.groups['Axes'], 'proficient');
  assert.equal(result.training.groups['Bows'], 'proficient');
  assert.equal(result.training.groups['Flails'], 'proficient');
  assert.ok(!('Not-a-group' in result.training.groups));
});

test('a known Arcane Archer subclass with an individual Trait weapon stays expert', () => {
  const id = 'sub-aa-trait';
  const result = derive([
    subclassItem(id, 'Arcane Archer', [
      traitAdvancement({ type: 'Trait', grants: ['weapon:shortbow'] }),
    ]),
  ]);

  // One provider, one merged source; the individual proficient weapon does not
  // create a duplicate provider nor downgrade the named expert group grant.
  assert.equal(result.sources.length, 1);
  assert.equal(result.training.groups['Bows'], 'expert');
  assert.equal(result.training.groups['Crossbows'], 'expert');
  assert.equal(result.training.items['bows/shortbow'], 'expert');
  assert.deepEqual(result.gaps, []);
});

test('removing a martial subclass recomputes training without the category grants', () => {
  const id = 'sub-custom-mar';
  const withSub = derive(
    [subclassItem(id, 'Custom Blade', [
      traitAdvancement({ type: 'Trait', grants: ['weapon:mar'] }),
    ])],
    { [id]: { groups: EIGHT } }
  );
  for (const group of EIGHT) assert.equal(withSub.training.groups[group], 'proficient');
  assert.deepEqual(withSub.gaps, []);

  const withoutSub = derive(
    [subclassItem('sub-other', 'Other')],
    { [id]: { groups: EIGHT } }
  );
  assert.deepEqual(Object.keys(withoutSub.training.groups), []);
  assert.deepEqual(withoutSub.gaps, []);
  assert.deepEqual(withoutSub.sources, []);
});

// ---------------------------------------------------------------------------
// Feat-based subclasses and expert feats
// ---------------------------------------------------------------------------

test('a feat matching a known subclass name is treated as that subclass', () => {
  const oh = 'feat-openhand';
  const result = derive(
    [featItem(oh, 'Way of the Open Hand')],
    { [oh]: { items: ['natural-weapons/bite'] } }
  );
  assert.equal(result.training.items['natural-weapons/bite'], 'expert');
  assert.deepEqual(result.gaps, []);
});

test('a subclass feat with a Trait grant contributes exactly one source', () => {
  const oh = 'feat-openhand';
  const result = derive(
    [
      featItem(oh, 'Way of the Open Hand', [
        traitAdvancement({ grants: ['weapon:battle-axe', 'weapon:bite'] }),
      ]),
    ],
    { [oh]: { items: ['natural-weapons/bite'] } }
  );
  // One provider, one source: the trait grant and the subclass grant are merged.
  assert.equal(result.sources.length, 1);
  assert.equal(result.training.items['axes/battle-axe'], 'proficient');
  // The subclass choice wins on the chosen natural weapon.
  assert.equal(result.training.items['natural-weapons/bite'], 'expert');
});

test('a known RME group expert feat requires exactly 4 chosen items', () => {
  const featId = 'feat-axes';
  const result = derive(
    [featItem(featId, 'Axe expert')],
    {
      [featId]: {
        items: ['axes/battle-axe', 'axes/broadaxe', 'axes/greataxe', 'axes/handaxe'],
      },
    }
  );
  assert.equal(result.training.items['axes/battle-axe'], 'expert');
  assert.equal(result.training.items['axes/handaxe'], 'expert');
  assert.deepEqual(result.gaps, []);
});

test('a group expert feat with fewer than 4 choices reports a gap', () => {
  const featId = 'feat-axes';
  const result = derive(
    [featItem(featId, 'Axe expert')],
    { [featId]: { items: ['axes/battle-axe', 'axes/broadaxe'] } }
  );
  const gap = result.gaps.find((g) => g.sourceId === featId);
  assert.ok(gap);
  assert.equal(gap.type, 'choices');
  assert.equal(gap.count, 4);
});

test('Weapon expert grants 4 chosen items and requires exactly 4', () => {
  const featId = 'feat-weapon';
  const result = derive(
    [featItem(featId, 'Weapon expert')],
    { [featId]: { items: ['axes/battle-axe', 'bows/shortbow', 'spears/lance', 'whips/whip'] } }
  );
  assert.equal(result.training.items['axes/battle-axe'], 'expert');
  assert.equal(result.training.items['whips/whip'], 'expert');
  assert.deepEqual(result.gaps, []);

  const short = derive([featItem(featId, 'Weapon expert')], {
    [featId]: { items: ['axes/battle-axe', 'bows/shortbow'] },
  });
  assert.ok(short.gaps.some((g) => g.sourceId === featId && g.type === 'choices'));
});

test('an invalid chaplet choice for a group expert feat reports a gap', () => {
  const featId = 'feat-axes';
  const result = derive(
    [featItem(featId, 'Axe expert')],
    { [featId]: { items: ['axes/battle-axe', 'axes/broadaxe', 'axes/greataxe', 'spears/lance'] } }
  );
  assert.ok(result.gaps.some((g) => g.sourceId === featId && g.type === 'choices'));
});

test('the RME expert feat group names map to the expected weapon groups', () => {
  const cases = [
    ['Combat Blade expert', 'combat-blades/scimitar', 'Combat Blades'],
    ['Dueling Blade expert', 'dueling-blades/rapier', 'Dueling Blades'],
    ['Hammer and Pick expert', 'hammers-picks/war-pick', 'Hammers Picks'],
  ];
  for (const [featName, itemId, group] of cases) {
    assert.ok(equipment.some((e) => e.id === itemId), `${featName}: bad fixture id ${itemId}`);
    const result = derive(
      [featItem('feat-x', featName)],
      {
        'feat-x': {
          items: [itemId, 'axes/battle-axe', 'bows/shortbow', 'whips/whip'],
        },
      }
    );
    assert.equal(result.training.items[itemId], 'expert', `${featName}`);
  }
});

// ---------------------------------------------------------------------------
// No silent grants
// ---------------------------------------------------------------------------

test('an irrelevant feat contributes nothing and no gap', () => {
  const result = derive([featItem('feat-gwm', 'Great Weapon Master')]);
  assert.deepEqual(Object.keys(result.training.groups), []);
  assert.deepEqual(Object.keys(result.training.items), []);
  assert.deepEqual(result.gaps, []);
  assert.deepEqual(result.sources, []);
});

test('an unrecognized expert feat reports a manual-review gap', () => {
  const featId = 'feat-mystery';
  const result = derive([featItem(featId, 'Mystery expert')]);
  const gap = result.gaps.find((g) => g.sourceId === featId);
  assert.ok(gap);
  assert.equal(gap.type, 'manual');
  assert.match(gap.reason, /manual review/);
  assert.deepEqual(Object.keys(result.training.items), []);
});

test('non-weapon expert feats (Shield expert / Natural Weapons expert) are manual gaps', () => {
  for (const name of ['Shield expert', 'Natural Weapons expert']) {
    const result = derive([featItem('feat-x', name)]);
    assert.ok(result.gaps.some((g) => g.type === 'manual'), `${name} should be manual`);
  }
});

test('aggregate actor trait fields are not read (no provenance)', () => {
  const fighterId = 'cls-fighter';
  const actor = {
    system: {
      details: { originalClass: fighterId },
      traits: { weapons: ['mar', 'sim', 'ls'], armor: 'lgt' },
    },
    items: [classItem(fighterId, 'Fighter', 'fighter')],
  };
  const result = deriveActorTraining(actor, equipment, { [fighterId]: { groups: EIGHT } });
  // The martial weapon entry in traits must not have leaked in; only the Axes
  // group (from the choice) and the fighter's fixed armor are present.
  assert.deepEqual(Object.keys(result.training.groups).sort(), [...EIGHT].sort());
  assert.ok(!('axes/battle-axe' in result.training.items));
});

// ---------------------------------------------------------------------------
// Two independent non-class sources promote to expert (rule sanity)
// ---------------------------------------------------------------------------

test('race + feat both proficient on an item promotes it to expert', () => {
  const result = derive([
    raceItem('race-a', 'Race A', [traitAdvancement({ grants: ['weapon:battle-axe'] })]),
    featItem('feat-a', 'Feat A', [traitAdvancement({ grants: ['weapon:battle-axe'] })]),
  ]);
  assert.equal(result.training.items['axes/battle-axe'], 'expert');
});

// ---------------------------------------------------------------------------
// Multiple classes with no original class
// ---------------------------------------------------------------------------

test('multiple classes with no originalClass reports a gap and treats all as multiclass', () => {
  const fighterId = 'c1';
  const barbId = 'c2';
  const result = derive(
    [classItem(fighterId, 'Fighter', 'fighter'), classItem(barbId, 'Barbarian', 'barbarian')],
    {
      [fighterId]: { groups: EIGHT },
      [barbId]: { groups: FOUR },
    }
  );

  assert.ok(result.gaps.some((g) => g.type === 'classes'));
  // Neither class promotes: battleaxe via either class stays proficient.
  assert.notEqual(result.training.items['axes/battle-axe'], 'expert');
  // Both are treated as multiclass, so simple weapons from barbarian are granted.
  assert.equal(result.training.items['dueling-blades/dagger'], 'proficient');
});

test('a single class with no originalClass is treated as the original class', () => {
  const fighterId = 'cls-fighter';
  const result = derive(
    [classItem(fighterId, 'Fighter', 'fighter')],
    { [fighterId]: { groups: EIGHT } }
  );
  assert.deepEqual(result.gaps, []);
  for (const group of EIGHT) assert.equal(result.training.groups[group], 'proficient');
});

// ---------------------------------------------------------------------------
// Regression: singular 'Trait' advancement, simple/martial trait keys, and
// class category partial choices
// ---------------------------------------------------------------------------

test('a singular dnd5e Trait advancement (type "Trait") grants its grants and chosen keys', () => {
  const featId = 'feat-singular';
  const result = derive([
    featItem(featId, 'Weapon Training', [
      traitAdvancement({
        type: 'Trait',
        grants: ['weapon:battle-axe'],
        chosen: new Set(['weapon:shortbow']),
        choices: { weapons: ['weapon:shortbow', 'weapon:battle-axe'] },
      }),
    ]),
  ]);
  assert.equal(result.training.items['axes/battle-axe'], 'proficient');
  assert.equal(result.training.items['bows/shortbow'], 'proficient');
  assert.deepEqual(result.gaps, []);
});

test('a singular Trait advancement with grants as a Set grants each weapon', () => {
  const raceId = 'race-set';
  const result = derive([
    raceItem(raceId, 'Traitset', [
      traitAdvancement({
        type: 'Trait',
        grants: new Set(['weapon:battle-axe', 'weapon:shortbow']),
      }),
    ]),
  ]);
  assert.equal(result.training.items['axes/battle-axe'], 'proficient');
  assert.equal(result.training.items['bows/shortbow'], 'proficient');
  assert.deepEqual(result.gaps, []);
});

test('weapon:sim and weapons:sim grant every RME simple weapon', () => {
  const a = derive([
    raceItem('race-sim-a', 'Simfolk A', [traitAdvancement({ grants: ['weapon:sim'] })]),
  ]);
  assert.equal(a.training.items['dueling-blades/dagger'], 'proficient');
  // A martial (Awkward) weapon is not simple and is not granted by sim.
  assert.ok(!('axes/battle-axe' in a.training.items));
  assert.deepEqual(a.gaps, []);

  const b = derive([
    raceItem('race-sim-b', 'Simfolk B', [traitAdvancement({ grants: ['weapons:sim'] })]),
  ]);
  assert.equal(b.training.items['dueling-blades/dagger'], 'proficient');
  assert.ok(!('axes/battle-axe' in b.training.items));
  assert.deepEqual(b.gaps, []);
});

test('a skill-only Trait choice pool does not raise an unselected-weapon gap', () => {
  const id = 'feat-skill';
  const result = derive([
    featItem(id, 'Skill Training', [
      traitAdvancement({ grants: [], chosen: [], choices: ['skill:acrobatics', 'tool:smith'] }),
    ]),
  ]);
  assert.deepEqual(result.gaps, []);
  assert.deepEqual(Object.keys(result.training.items), []);
  assert.deepEqual(Object.keys(result.training.groups), []);
});

test('a nested weapon choice pool { count, pool } raises an unselected-weapon gap', () => {
  const id = 'feat-nested';
  const result = derive([
    featItem(id, 'Weapon Training', [
      traitAdvancement({
        grants: [],
        chosen: [],
        choices: [{ count: 1, pool: ['weapon:shortbow', 'weapon:battle-axe'] }],
      }),
    ]),
  ]);
  const gap = result.gaps.find((g) => g.sourceId === id);
  assert.ok(gap, 'expected an unselected nested weapon pool gap');
  assert.equal(gap.type, 'choices');
  assert.deepEqual(Object.keys(result.training.items), []);
  assert.deepEqual(Object.keys(result.training.groups), []);
});

test('a nested weapon choice pool with a Set pool raises an unselected-weapon gap', () => {
  const id = 'feat-nested-set';
  const result = derive([
    featItem(id, 'Weapon Training', [
      traitAdvancement({
        grants: [],
        chosen: [],
        choices: [{ count: 1, pool: new Set(['weapon:shortbow', 'weapon:battle-axe']) }],
      }),
    ]),
  ]);
  const gap = result.gaps.find((g) => g.sourceId === id);
  assert.ok(gap, 'expected an unselected nested weapon pool gap');
  assert.equal(gap.type, 'choices');
});

test('a nested skill-only choice pool does not raise an unselected-weapon gap', () => {
  const id = 'feat-nested-skill';
  const result = derive([
    featItem(id, 'Skill Training', [
      traitAdvancement({
        grants: [],
        chosen: [],
        choices: [{ count: 1, pool: ['skill:acrobatics', 'tool:smith'] }],
      }),
    ]),
  ]);
  assert.deepEqual(result.gaps, []);
  assert.deepEqual(Object.keys(result.training.items), []);
  assert.deepEqual(Object.keys(result.training.groups), []);
});

test('a weapon-prefixed Trait choice pool with nothing chosen still reports the gap', () => {
  const id = 'feat-weaponpool';
  const result = derive([
    featItem(id, 'Weapon Training', [
      traitAdvancement({ grants: [], chosen: [], choices: ['weapon:shortbow', 'skill:acrobatics'] }),
    ]),
  ]);
  const gap = result.gaps.find((g) => g.sourceId === id);
  assert.ok(gap);
  assert.equal(gap.type, 'choices');
});

test('Arcane Archer group expert with an individual weapon prof stays expert', () => {
  const result = derive([
    subclassItem('sub-aa', 'Arcane Archer'),
    raceItem('race-bow', 'Bowfolk', [traitAdvancement({ grants: ['weapon:shortbow'] })]),
  ]);
  assert.equal(result.training.groups['Bows'], 'expert');
  assert.equal(result.training.groups['Crossbows'], 'expert');
  assert.equal(result.training.items['bows/shortbow'], 'expert');
});

test('a partial original category choice reports a groups gap and keeps valid grants', () => {
  const fighterId = 'cls-fighter';
  const result = derive(
    [classItem(fighterId, 'Fighter', 'fighter')],
    { [fighterId]: { groups: ['Axes', 'Bows'] } },
    { originalClass: fighterId }
  );
  const gap = result.gaps.find((g) => g.sourceId === fighterId && g.type === 'groups');
  assert.ok(gap);
  assert.equal(gap.count, 8);
  assert.ok(Array.isArray(gap.options) && gap.options.includes('Axes'));
  // The valid partial grants are applied; the missing categories are not guessed.
  assert.equal(result.training.groups['Axes'], 'proficient');
  assert.equal(result.training.groups['Bows'], 'proficient');
  assert.ok(!('Crossbows' in result.training.groups));
});

test('a partial multiclass category choice reports a groups gap and keeps valid grants', () => {
  const f1 = 'c1';
  const f2 = 'c2';
  const result = derive(
    [classItem(f1, 'Fighter', 'fighter'), classItem(f2, 'Fighter', 'fighter')],
    { [f1]: { groups: EIGHT }, [f2]: { groups: ['Crossbows', 'Firearms'] } },
    { originalClass: f1 }
  );
  const gap = result.gaps.find((g) => g.sourceId === f2 && g.type === 'groups');
  assert.ok(gap);
  assert.equal(gap.count, 4);
  // The valid partial multiclass grants are applied; the missing categories are
  // not guessed.
  assert.equal(result.training.groups['Crossbows'], 'proficient');
  assert.equal(result.training.groups['Firearms'], 'proficient');
  assert.ok(!('Throwing Weapons' in result.training.groups));
});

// ---------------------------------------------------------------------------
// Unsupported / homebrew class identifiers never throw; surfaced as manual gap
// ---------------------------------------------------------------------------

test('an unknown original class reports a manual gap and does not throw', () => {
  const homebrewId = 'cls-warden';
  const result = derive(
    [classItem(homebrewId, 'Warden', 'Warden')],
    {},
    { originalClass: homebrewId }
  );

  // Capitalized identifier is normalized (as in the source) before matching;
  // the class is unknown and must not throw.
  const gap = result.gaps.find((g) => g.sourceId === homebrewId);
  assert.ok(gap, 'expected a manual gap for the unknown original class');
  assert.equal(gap.type, 'manual');
  assert.match(gap.reason, /Unsupported class identifier warden/);
  assert.match(gap.reason, /assign RME training manually/);
  assert.equal(gap.label, 'Warden');
  assert.deepEqual(Object.keys(result.training.groups), []);
  assert.deepEqual(Object.keys(result.training.items), []);
  assert.deepEqual(result.sources, []);
});

test('a class item with no identifier reports a manual gap and does not throw', () => {
  const homebrewId = 'cls-noident';
  const result = derive(
    [classItem(homebrewId, 'Mystic', undefined)],
    {},
    { originalClass: homebrewId }
  );

  const gap = result.gaps.find((g) => g.sourceId === homebrewId);
  assert.ok(gap, 'expected a manual gap for the class missing an identifier');
  assert.equal(gap.type, 'manual');
  assert.match(gap.reason, /Unsupported class identifier/);
  assert.deepEqual(result.sources, []);
});

test('a mixed Fighter and unknown multiclass class does not throw; Fighter grants remain', () => {
  const fighterId = 'cls-fighter';
  const homebrewId = 'cls-warden';
  const result = derive(
    [
      classItem(fighterId, 'Fighter', 'fighter'),
      classItem(homebrewId, 'Warden', 'warden'),
    ],
    { [fighterId]: { groups: EIGHT } },
    { originalClass: fighterId }
  );

  // The unknown multiclass class is surfaced as a manual gap, not a crash.
  const gap = result.gaps.find((g) => g.sourceId === homebrewId);
  assert.ok(gap, 'expected a manual gap for the unknown multiclass class');
  assert.equal(gap.type, 'manual');
  assert.match(gap.reason, /Unsupported class identifier warden/);

  // The known Fighter grants are still applied; the unknown class is not a source.
  assert.equal(result.training.groups['Axes'], 'proficient');
  assert.deepEqual(result.sources.map((s) => s.id), [fighterId]);
});

// ---------------------------------------------------------------------------
// Source-specific class Trait weapon/armor grants (merged into the class source)
// ---------------------------------------------------------------------------

test('a class Trait weapon grant is merged into the class source', () => {
  const fighterId = 'cls-fighter';
  const result = derive(
    [
      classItem(fighterId, 'Fighter', 'fighter', [
        traitAdvancement({ type: 'Trait', grants: ['weapon:crossbows/light-crossbow'] }),
      ]),
    ],
    { [fighterId]: { groups: EIGHT } },
    { originalClass: fighterId }
  );

  // One provider contributes exactly one merged source; the specific weapon is
  // granted by that same class source at proficient.
  assert.equal(result.sources.length, 1);
  assert.equal(result.sources[0].id, fighterId);
  assert.equal(result.training.items['crossbows/light-crossbow'], 'proficient');
  assert.deepEqual(result.gaps, []);
});

test('a class Trait chosen weapon is merged into the class source', () => {
  const fighterId = 'cls-fighter';
  const result = derive(
    [
      classItem(fighterId, 'Fighter', 'fighter', [
        traitAdvancement({ type: 'Trait', grants: [], chosen: ['weapon:crossbows/light-crossbow'] }),
      ]),
    ],
    { [fighterId]: { groups: EIGHT } },
    { originalClass: fighterId }
  );

  assert.equal(result.sources.length, 1);
  assert.equal(result.training.items['crossbows/light-crossbow'], 'proficient');
  assert.deepEqual(result.gaps, []);
});

test('a generic class martial Trait grant (weapon:mar) is ignored, no false gap', () => {
  const fighterId = 'cls-fighter';
  const result = derive(
    [
      classItem(fighterId, 'Fighter', 'fighter', [
        traitAdvancement({ type: 'Trait', grants: ['weapon:mar'] }),
      ]),
    ],
    { [fighterId]: { groups: EIGHT } },
    { originalClass: fighterId }
  );

  // weapon:mar is superseded by the RME ClassTraining table: it must not raise
  // an unknown-weapon gap, nor grant every weapon individually.
  assert.deepEqual(result.gaps, []);
  assert.equal(result.sources.length, 1);
  for (const group of EIGHT) assert.equal(result.training.groups[group], 'proficient');
});

test('a class cannot promote itself from its own Trait weapon grant', () => {
  const fighterId = 'cls-fighter';
  const result = derive(
    [
      classItem(fighterId, 'Fighter', 'fighter', [
        traitAdvancement({ type: 'Trait', grants: ['weapon:battle-axe'] }),
      ]),
    ],
    { [fighterId]: { groups: EIGHT } },
    { originalClass: fighterId }
  );

  // The battle-axe is covered by the same class's Axes group and its own weapon
  // grant, but they are ONE source, so the item stays proficient (not expert).
  assert.equal(result.sources.length, 1);
  assert.equal(result.training.groups['Axes'], 'proficient');
  assert.equal(result.training.items['axes/battle-axe'], 'proficient');
  assert.deepEqual(result.gaps, []);
});

test('an unsupported class keeps its manual gap but still recognizes a specific Trait weapon', () => {
  const homebrewId = 'cls-warden';
  const result = derive(
    [
      classItem(homebrewId, 'Warden', 'warden', [
        traitAdvancement({ type: 'Trait', grants: ['weapon:battle-axe'] }),
      ]),
    ],
    {},
    { originalClass: homebrewId }
  );

  const gap = result.gaps.find((g) => g.sourceId === homebrewId && g.type === 'manual');
  assert.ok(gap, 'expected the unsupported class manual gap');
  assert.match(gap.reason, /Unsupported class identifier warden/);

  // The specific Trait weapon is still collected under the same provider source.
  assert.equal(result.sources.length, 1);
  assert.equal(result.sources[0].id, homebrewId);
  assert.equal(result.sources[0].grants.items['axes/battle-axe'], 'proficient');
  assert.equal(result.training.items['axes/battle-axe'], 'proficient');
});

test('an unknown class Trait weapon key surfaces a manual-review gap', () => {
  const homebrewId = 'cls-warden';
  const result = derive(
    [
      classItem(homebrewId, 'Warden', 'warden', [
        traitAdvancement({ type: 'Trait', grants: ['weapon:zap'] }),
      ]),
    ],
    {},
    { originalClass: homebrewId }
  );

  const manualGaps = result.gaps.filter((g) => g.sourceId === homebrewId && g.type === 'manual');
  assert.equal(manualGaps.length, 2, 'expected both the unsupported-class and unknown-key manual gaps');
  assert.ok(manualGaps.some((g) => /Unknown class Trait key weapon:zap/.test(g.reason)));
  assert.deepEqual(Object.keys(result.training.items), []);
});

test('a multiclass class Trait weapon grant is merged into the multiclass source', () => {
  const fighterId = 'cls-fighter';
  const barbId = 'cls-barbarian';
  const result = derive(
    [
      classItem(fighterId, 'Fighter', 'fighter'),
      classItem(barbId, 'Barbarian', 'barbarian', [
        traitAdvancement({ type: 'Trait', grants: ['weapon:crossbows/light-crossbow'] }),
      ]),
    ],
    { [fighterId]: { groups: EIGHT }, [barbId]: { groups: FOUR } },
    { originalClass: fighterId }
  );

  // The multiclass barbarian is a single provider source that merges its table
  // grants with the specific Trait weapon.
  assert.equal(result.sources.length, 2);
  const barbSource = result.sources.find((s) => s.id === barbId);
  assert.ok(barbSource, 'expected a barbarian source');
  assert.equal(barbSource.grants.items['crossbows/light-crossbow'], 'proficient');
  assert.equal(result.training.items['crossbows/light-crossbow'], 'proficient');
  assert.deepEqual(result.gaps, []);
});

// ---------------------------------------------------------------------------
// Class Trait level / original-vs-multiclass gating
// ---------------------------------------------------------------------------

test('a class Trait at a future level is skipped for a lower-level class (level1 vs level3)', () => {
  const fighterId = 'cls-fighter';
  const low = derive(
    [
      classItem(fighterId, 'Fighter', 'fighter', [
        traitAdvancement({ type: 'Trait', grants: ['weapon:crossbows/light-crossbow'], level: 3 }),
      ], 1),
    ],
    { [fighterId]: { groups: EIGHT } },
    { originalClass: fighterId }
  );
  assert.ok(!('crossbows/light-crossbow' in low.training.items));
  assert.deepEqual(low.gaps, []);

  const high = derive(
    [
      classItem(fighterId, 'Fighter', 'fighter', [
        traitAdvancement({ type: 'Trait', grants: ['weapon:crossbows/light-crossbow'], level: 3 }),
      ], 3),
    ],
    { [fighterId]: { groups: EIGHT } },
    { originalClass: fighterId }
  );
  assert.equal(high.training.items['crossbows/light-crossbow'], 'proficient');
  assert.deepEqual(high.gaps, []);
});

test('a class Trait with a level but no class levels is still granted (no gap)', () => {
  const fighterId = 'cls-fighter';
  const result = derive(
    [
      classItem(fighterId, 'Fighter', 'fighter', [
        traitAdvancement({ type: 'Trait', grants: ['weapon:crossbows/light-crossbow'], level: 3 }),
      ]),
    ],
    { [fighterId]: { groups: EIGHT } },
    { originalClass: fighterId }
  );
  assert.equal(result.training.items['crossbows/light-crossbow'], 'proficient');
  assert.deepEqual(result.gaps, []);
});

test('a primary-only class Trait is ignored on a multiclass class', () => {
  const fighterId = 'cls-fighter';
  const barbId = 'cls-barbarian';
  const result = derive(
    [
      classItem(fighterId, 'Fighter', 'fighter'),
      classItem(barbId, 'Barbarian', 'barbarian', [
        traitAdvancement({ type: 'Trait', grants: ['weapon:whips/whip'], classRestriction: 'primary' }),
      ]),
    ],
    { [fighterId]: { groups: EIGHT }, [barbId]: { groups: FOUR } },
    { originalClass: fighterId }
  );
  // The multiclass barbarian's base table does not grant Whips, and the
  // primary-only Trait is skipped, so the source grants nothing for Whips.
  const barbSource = result.sources.find((s) => s.id === barbId);
  assert.ok(!('whips/whip' in barbSource.grants.items));
  assert.ok(!('whips/whip' in result.training.items));
  assert.deepEqual(result.gaps, []);
});

test('a secondary-only class Trait is ignored on the original class', () => {
  const fighterId = 'cls-fighter';
  const result = derive(
    [
      classItem(fighterId, 'Fighter', 'fighter', [
        traitAdvancement({ type: 'Trait', grants: ['weapon:crossbows/light-crossbow'], classRestriction: 'secondary' }),
      ]),
    ],
    { [fighterId]: { groups: EIGHT } },
    { originalClass: fighterId }
  );
  assert.ok(!('crossbows/light-crossbow' in result.training.items));
  assert.deepEqual(result.gaps, []);
});

test('a primary-only class Trait is granted on the original class', () => {
  const fighterId = 'cls-fighter';
  const result = derive(
    [
      classItem(fighterId, 'Fighter', 'fighter', [
        traitAdvancement({ type: 'Trait', grants: ['weapon:crossbows/light-crossbow'], classRestriction: 'primary' }),
      ]),
    ],
    { [fighterId]: { groups: EIGHT } },
    { originalClass: fighterId }
  );
  assert.equal(result.training.items['crossbows/light-crossbow'], 'proficient');
  assert.deepEqual(result.gaps, []);
});

test('a secondary-only class Trait is granted on a multiclass class', () => {
  const fighterId = 'cls-fighter';
  const barbId = 'cls-barbarian';
  const result = derive(
    [
      classItem(fighterId, 'Fighter', 'fighter'),
      classItem(barbId, 'Barbarian', 'barbarian', [
        traitAdvancement({ type: 'Trait', grants: ['weapon:whips/whip'], classRestriction: 'secondary' }),
      ]),
    ],
    { [fighterId]: { groups: EIGHT }, [barbId]: { groups: FOUR } },
    { originalClass: fighterId }
  );
  // Whips are not in the multiclass barbarian base table, so the only way the
  // source grants the whip is the secondary-only Trait being applied.
  const barbSource = result.sources.find((s) => s.id === barbId);
  assert.equal(barbSource.grants.items['whips/whip'], 'proficient');
  assert.equal(result.training.items['whips/whip'], 'proficient');
  assert.deepEqual(result.gaps, []);
});

test('a race Trait is unaffected by class level / restriction gating', () => {
  const fighterId = 'cls-fighter';
  const result = derive(
    [
      classItem(fighterId, 'Fighter', 'fighter', [
        traitAdvancement({ type: 'Trait', grants: ['weapon:crossbows/light-crossbow'], level: 3 }),
      ], 1),
      raceItem('race-dwarf', 'Dwarf', [
        traitAdvancement({ grants: ['weapon:crossbows/light-crossbow'] }),
      ]),
    ],
    { [fighterId]: { groups: EIGHT } },
    { originalClass: fighterId }
  );
  // The class Trait at level 3 is skipped for the level-1 fighter, but the race
  // Trait is not level- or restriction-gated and still grants the weapon.
  assert.equal(result.training.items['crossbows/light-crossbow'], 'proficient');
  assert.deepEqual(result.gaps, []);
});
