# Revised Martial Equipment for Foundry VTT

Foundry VTT 14 module for the generated RME catalog and dnd5e 6.0.6 item integration.

## Requirements

- **Node.js 20+** to build the catalog and run the test suite. There are no runtime npm dependencies, so `node` alone is enough to run `npm run build:catalog` and `npm test`.
- **Foundry VTT 14.367+** with the **dnd5e system 6.0.6+**.

## Install from a GitHub release

The module is published as a GitHub release on every push to `main`, so it can be
installed directly in Foundry VTT from a manifest URL. No file access on your
machine is needed.

- **Manifest URL** (the only value you need):

  ```
  https://github.com/sepffuzzball/foundry-rme/releases/latest/download/module.json
  ```

To install:

1. In Foundry VTT, open **Setup** and click **Install Module**.
2. On the **Install Module** screen, click **Install a module**.
3. In the **Manifest URL** field, paste the manifest URL above.
4. Click **Install**. Foundry downloads the release and installs the module
   under `Data/modules/foundry-rme`; no manual file access is required.

The repository is public, so Foundry can fetch the manifest and the release ZIP
directly from GitHub. Updates are delivered through Foundry's own **Update
modules** flow: when a new release is published, the manifest URL points to the
newest release, and the **Update** button in the module manager applies it.
After a new release, update the module through that flow, and back up your world
before applying the update.

Note for installs copied by hand: if you previously installed the module by
copying the `foundry-rme` folder into `Data/modules`, that install is not tied to
a manifest URL, so Foundry will not offer updates for it. To switch to
release-based installs, uninstall the module (or remove the copied folder) and
reinstall it from the manifest URL above. While the module is absent the
module-provided packs and files become unavailable, but Items you imported into
the world generally remain. Still, back up your world before switching, and
reinstall the module before opening the world again so no referenced content is
missing.

## Compendium packs

Every release ships four precompiled Foundry compendium packs, so they are
available the moment the module is installed - no build step and no catalog
import is required:

- **RME Weapons** (153 items, including natural weapons)
- **RME Armor** (12 items)
- **RME Shields** (8 items)
- **RME Ammunition** (25 stack items)

The **RME Ammunition** pack is a set of consumable ammunition stacks rather than
a weapon class. Each stack is a dnd5e consumable with `system.type`
`{value:'ammo', subtype:'rme-<family>'}` and a per-unit price, so a full stack
(20 bolts or arrows, or a single Multi-Purpose Launcher round) adds up to the
user-approved cost. Each stack carries an explicit zero weight and a
`flags.foundry-rme` block recording its ammo id, family, stack cost, and a
declarative `effect` object: a plain-text summary plus structured fields such as
damage type, attack/damage bonus, saving throws, conditions, or payload. The
catalog is the authoritative source: the module never invents a value. In this
release a subset of those effects is automated - the approved +1/+2 attack and
damage bonuses and the elemental extra 1d4 typed damage (fire, cold, poison,
lightning, acid, thunder) are applied to module-managed ranged attack and
chat-card damage rolls, and buckshot reduces one base damage die by one when the
weapon base damage is a simple `NdM` (N>=2) formula. Saves, conditions, area
bursts, the buckshot cone, and player action economy are still applied by hand
(see Automation limitations). These stacks are module homebrew defaults, not
original RME source rule text.

For tagged weapons, the native Item Details RME panel can assign a compatible
actor-owned reserve stack and reload magazines. Import one of the 25 stack items
from **RME Ammunition** first (Portable Ballista may also use Javelin). How a
weapon spends ammunition depends on whether it is direct or magazine-managed.
Bows and ordinary crossbows spend their assigned reserve directly, one round per
shot. The Repeating Crossbow (6 bolts) and the Spinner (10 bladed disks) are
magazine-managed: they transfer rounds from the reserve on reload and spend
loaded rounds on fire. Firearms with Loading (#) use a magazine of that tier's
capacity; when no Loading property is present, ammunition is spent directly. The
Portable Ballista is direct but does not use a consumable
stack: it spends an ordinary Javelin actor weapon stack, one javelin per shot.
A magazine weapon exposes loaded/capacity and reload options, and its row in an
actor's inventory shows a `loaded/capacity` badge; the native Uses/charges
tracker is not used for RME ammunition. Native dnd5e ammunition consumption is
not used, and turn costs are player enforced.
Cross-client concurrent shots can race: ammunition state is not coordinated
across clients (no cross-client atomicity). The +1/+2 and elemental damage
effects are applied automatically on attacked shots; saves, conditions, area
bursts, the buckshot cone, and player action economy remain manual.

Open any of these from Foundry's **Compendium** tab. Drag an item onto a
character sheet (or use the pack's import action) and it opens the native dnd5e
item sheet with the RME catalog data already filled in. The packs are LevelDB
directories compiled by `npm run build:packs` and embedded in the release
archive, so installing the module never requires you to compile them yourself.

The GM-only **RME Catalog** button remains optional. It imports selected entries
or the full catalog into the world, and can target an owned actor. If you
prefer, you can ignore it entirely and rely solely on the bundled compendium
packs.

## Local development and install

Add the module folder to `Data/modules/foundry-rme` and enable it in the world.

For development, symlink (or copy) this repository into `Data/modules/foundry-rme` so Foundry loads the module straight from your working copy. A symlink works on Linux and macOS; on Windows you may need to copy the folder instead of linking if Foundry does not resolve the link.

Before using a local checkout with Foundry, install the dependencies and build
the catalog and compendium packs from your working copy:

```
npm ci
npm run build:catalog
npm run build:packs
```

`npm ci` installs the pinned build tooling from the lockfile; `npm run
build:catalog` regenerates `data/catalog.json` from `rules/`, and `npm run
build:packs` compiles the four compendium packs (the release ships them
precompiled, but a local checkout does not). Re-run `npm run build:catalog`
after any change to `rules/`, and `npm run build:packs` after any change to the
pack definitions. Run the test suite with:

```
npm test
```

## Usage

GMs can open the catalog from an actor sheet's **RME Catalog** header control; they can import selected entries or the full catalog into the world, or select an owned actor to receive selected entries. Existing catalog Items are detected by `flags.foundry-rme.catalogId` and never overwritten. The `game.rme.openCatalog()` and `game.rme.importCatalog({actor})` APIs remain available.

Owned actor sheets receive an **RME Training** header control, and
`game.rme.openTraining(actor?)` opens the same editor (it uses the supplied
owned actor when one is given, otherwise the controlled token actor or your
character). Dropping a class, race, feat, or subclass Item onto an actor - or
changing one that is already there - triggers an automatic training sync that
derives the actor's RME weapon/armor training and synchronizes the actor's
catalog Items to the result. Derivation does not run the native dnd5e class
advancement; it follows source-specific rules.

Character sheets also show a read-only **RME Armor** and **RME Weapons** summary
in the Details tab beside the native proficiency pills. Expert tiers are marked
with an Expert badge; expand the exception count to see each item's actual
training, including exclusions - this works by keyboard. If a group is not
trained, its positive individual items appear instead. These RME summaries do
not edit or replace native dnd5e armor or weapon traits.

- **Classes** are resolved through the RME ClassTraining table
  (included as `rules/ClassTraining.md`), not just their Trait advancements. A
  recognized class identifier drives the class's weapon-category and
  armor/shield grants: an original-class Fighter prompts for its 8
  weapon-category choices, while a multiclass Fighter prompts for a 4-category
  choice (barbarian, paladin, and ranger follow the same original/multiclass
  split). Any explicit Trait advancement grant on the class Item - for example a
  Trait granting a specific weapon - is also read and merged into the same
  source.

- **Race, feat, and subclass** Items are read through their Trait advancements.
  A Dwarf race Item whose Trait advancement grants `weapon:battle-axe` confers
  axe training, and a feat Item named "Axe expert" grants the axe group it
  names, with the chosen items prompted rather than guessed. A feat or subclass
  Item that matches a known expert/subclass name is handled by the module's own
  tables instead, which is why an unrecognized expert feat surfaces as a gap.

Manual group/item overrides always take precedence over the derived value; the
dialog shows each item's origin (manual override, derived source, or natural
default) so a manual choice is never mistaken for an automatic one. Choosing
Untrained is an explicit override, while Inherit removes the override.
Original-class and multiclass weapon-category choices (8 and 4, respectively)
and expert/subclass item choices are prompted in the RME Training dialog rather
than guessed, and these source-linked choices are saved against the provider
that granted them.

Gaps are reported only for something the module can see on an embedded
supported source but cannot map safely: an unsupported class identifier, an
unrecognized feat, or an unknown weapon/armor trait key. A grant the module
cannot see - one not represented by an embedded class/race/feat/subclass Item or
a Trait advancement on such an Item, such as a proficiency a DM applied by hand -
is invisible to derivation, so it is never surfaced as a gap. Those grants must
be added as manual group/item overrides in the dialog. RME never guesses
silently: what it sees and cannot map is surfaced for manual review. Save
persists both training and provider-keyed choices and synchronizes supported
module-owned fields. The RME Training dialog's entire content scrolls, and the
Save training button stays reachable outside the scrolling area.

Tagged catalog Items also show an additive **RME Equipment** panel at the top
of the native dnd5e item Details tab. It displays the effective tier, RME
properties, and all three source profiles without replacing native Proficiency
or Mastery. Curated item descriptions are prose-only: the name heading, italic
stat line, armor table row, tier rows, and the Expert Perk are stripped from the
description, so nothing is duplicated between the panel and the description.
The chat snippet is a short excerpt, and unidentified items use a generic name
and appearance; the original full RME rule text stays available in the RME
Catalog and the panel's source profiles. On an owned actor's Item, **Manual
item training** sets an item override; **Inherit** removes it. World Items and
compendium previews use a non-persistent tier selector (compendium Items remain
read-only). RME properties are reference information available while equipped,
not tactical automation; the native Mastery value is never touched. When a sync
migrates a legacy actor item, its description fields are rewritten only while
they are still the untouched legacy/blank form (or a placeholder icon), so a
user edit to the description or icon is preserved.

The catalog view contains all 173 equipment entries and 24 reference sections. Source markdown is displayed as escaped preformatted text, not interpreted HTML.

## Automation limitations

Automation is intentionally limited to what has a faithful, unambiguous native
counterpart. The module synchronizes the module-owned fields: the training level
applied to an actor's RME items, the selected RME profile (the tier rows that
resolve at that level), and the parsed range and base damage for a weapon when a
sole parseable attack profile exists (a tier with no single parseable profile is
left for you to fill in). A conservative subset of shared RME weapon properties
is promoted into native dnd5e keys - `two` (Two-Handed), `fin` (Finesse), melee
`rch` (Reach), and `ver` (Versatile, with its parsed two-handed die) - while the
rest of the granted RME properties are written only under the module's own
`rme-*` namespace. Some RME properties are deliberately not mapped onto a native
key because their mechanics differ or a native key would double-count: Heavy,
Light, Loading, Reload, and Firearm are not promoted, and native ammunition
management is skipped because the module tracks ammo itself. RME's extra
half-Strength bonus on a two-handed melee/versatile weapon, and the tactical
effects (Hipshot, Keen, Puncture, and so on), remain manual. The fighting-style
and spell/ability rule texts stay reference material.

The **RME Ammunition** pack follows the same limited-automation rule. Each stack
carries a declared `flags.foundry-rme.effect` object (damage type, attack/damage
bonus, saving throws, conditions, or payload) and a descriptive source text.
Ammunition is consumed on an attack, and a subset of the approved effects is now
applied automatically: the +1/+2 attack and damage bonuses, the elemental extra
1d4 typed damage, and - only when the weapon's pertinent base damage is a simple
`NdM` (N>=2) formula - the buckshot one-fewer-base-die reduction, which leaves
ambiguous formulas unchanged. Saves, conditions, area bursts, the buckshot cone,
and player action economy are still applied by hand, because they require
targeting and permission handling the module does not orchestrate. The
`flags.foundry-rme.effect` object is reference data the module reads, not a
guarantee of full automation.

Training derivation is automatic for class, race, feat, and subclass sources
the module recognizes. It is driven by source-specific rules rather than the
native dnd5e class advancement: recognized classes are resolved through the RME
ClassTraining table, and race/feat/subclass Items contribute their Trait
advancement grants. Anything it can see but cannot map is surfaced as a gap
rather than guessed - unsupported custom classes, unrecognized expert feats, and
unknown weapon/armor trait keys - while original-class / multiclass / expert
choices are prompted in the RME Training dialog. A grant that is not represented
by an embedded class/race/feat/subclass Item or a Trait advancement is invisible
to derivation, so it is not a gap; add it as a manual group/item override. There
is no starting-class seeding to enable - the choices are prompted directly.

The current release has **not yet been verified by the developer in a live
Foundry world**. The automated test suite exercises the pure logic and the
runtime API surface, but real Foundry/dnd5e rendering and actor interactions -
including the new ammunition attack/damage automation on a real chat card - are
not covered by it. A user report indicates the module was installed and ran
under a prior release, but this release remains unverified. Cross-client
concurrent shots are not atomic: ammunition state is not coordinated across
clients.

## Repository contents

- `rules/` - source markdown for the equipment catalog and references, included intentionally. Editing these is how you change the catalog.
- `data/catalog.json` - the generated catalog, committed intentionally so the module runs without requiring a build step on install.
- `data/ammunition.json` - the ammunition stack source (25 consumable entries) that the `build:packs` step compiles into the RME Ammunition pack.
- `data/icon-map.json` - the catalog id to bundled icon-path map used as the attribution-audit source for the released icon set. It mirrors the runtime `src/icon-map.mjs` and is shipped with the release as a record of which icons are bundled.
- `assets/icons/` - the offline bundled icon set (unmodified Game-icons.net originals, CC BY 3.0) referenced by the icon map and shipped with every release.
- `ICON_ATTRIBUTION.md` - the per-icon attribution (author, upstream path, pinned source URL) for every bundled icon, shipped with the release.
- `src/`, `tests/`, `scripts/`, `styles/`, `module.json` - the module code, tests, catalog build script, styles, and manifest.
- `graphify-out/` - the local graphify knowledge-graph output. It is **ignored** (see `.gitignore`) and not part of the published module; regenerate it locally with `graphify update .` if you use it.

## Bundled icons

The module ships an offline set of equipment and ammunition icons
under `assets/icons/` so item artwork is available the moment the module is
installed, with no network access and no hotlinking to an external host. Every
icon is sourced from the
[Game-icons.net icon set](https://game-icons.net/) and is an unmodified official
original distributed under the
[Creative Commons Attribution 3.0 Unported (CC BY 3.0)](https://creativecommons.org/licenses/by/3.0/)
license.

The icons are bundled offline, so they keep working even when Foundry has no
outbound connection. The full per-icon credits - author, upstream source path,
and the pinned source URL - are recorded in
[`ICON_ATTRIBUTION.md`](ICON_ATTRIBUTION.md), which is included with every
release alongside the icons. The module and its items reference only the
bundled `assets/icons/` files; no icon is pulled from a CDN or external URL at
runtime.

## License

No license is currently supplied. A repository can be publicly visible without a `LICENSE` file, so publishing does not require choosing a license. But absent a `LICENSE` file, reuse of the code and rules remains restricted: the default is "all rights reserved", even though the repo is publicly visible. If you want redistribution and reuse, choose appropriate licenses for both the source code and the bundled `rules/` (they may differ), with the rights holder's approval, and add license notices before inviting reuse.

## Publishing to GitHub

The repository already exists publicly at
[https://github.com/sepffuzzball/foundry-rme](https://github.com/sepffuzzball/foundry-rme).
To publish changes, commit them locally and push to `main`:

```
git push origin main
```

## Releases

A GitHub release is published automatically by a workflow that runs on every push
to `main`. It requires no manual steps and no personal tokens: the workflow uses
the built-in `GITHUB_TOKEN` granted only the `contents: write` permission it
needs to create releases. Release notes are generated from the pushed commits.

The release version and tag are derived deterministically from the tracked
`module.json` version and the GitHub Actions run number:

- The tracked `module.json` version is strict `major.minor.patch`.
- The release version is `major.minor.(patch + run-number)`, so run number `1`
  produces `0.1.1` and the tag `v0.1.1`, run number `2` produces `0.1.2` and the
  tag `v0.1.2`, and so on.

Each release provides two assets:

- `module.json` - the manifest Foundry polls for update checks. It is published
  at the `latest` download URL and always reflects the newest release.
- `foundry-rme.zip` - the installable module archive, with `module.json` at the
  archive root (not under a `package/` folder) as Foundry requires. It embeds the
  four precompiled compendium packs (`packs/weapons`, `packs/armor`,
  `packs/shields`, `packs/ammunition`) as LevelDB directories, so they are usable
  immediately on install.

The tracked `module.json` in the repository is never modified by the release
process; the `manifest` and `download` fields are stamped only into the staged
release copy. The workflow also guards against publishing a stale catalog: it
rebuilds `data/catalog.json` from `rules/` before packaging and fails the release
if the rebuild changes the committed `data/catalog.json`. That means any change to
`rules/` requires the regenerated catalog to be committed; otherwise the release
fails. The first release is published
automatically once this workflow is merged and pushed to `main`.
