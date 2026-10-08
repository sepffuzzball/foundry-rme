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

Every release ships three precompiled Foundry compendium packs, so they are
available the moment the module is installed - no build step and no catalog
import is required:

- **RME Weapons** (153 items, including natural weapons)
- **RME Armor** (12 items)
- **RME Shields** (8 items)

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
build:packs` compiles the three compendium packs (the release ships them
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
module-owned fields.

Tagged catalog Items also show an additive **RME Equipment** panel in the
native dnd5e item Details tab. It displays the effective tier, RME properties,
and all three source profiles without replacing native Proficiency or Mastery.
On an owned actor's Item, **Manual item training** sets an item override;
**Inherit** removes it. World Items and compendium previews use a non-persistent
tier selector (compendium Items remain read-only). RME properties are reference
information available while equipped, not tactical automation; the source item
description and native mastery remain unchanged.

The catalog view contains all 173 equipment entries and 24 reference sections. Source markdown is displayed as escaped preformatted text, not interpreted HTML.

## Automation limitations

Automation is intentionally limited. The module synchronizes only the training
level and, for a weapon or natural weapon, only unambiguous single `Melee NdX` /
`Ranged NdX(+N)` base damage (range is set only for a sole ranged profile; a tier
with no single parseable profile is left for you to fill in). RME's tactical
properties (Hipshot, Keen, Puncture, and so on) are not mapped into dnd5e native
properties, and the fighting-style and spell/ability rule texts remain reference
material - all of that stays manual.

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
runtime API surface, but real Foundry/dnd5e rendering and actor interactions are
not covered by it. A user report indicates the module was installed and ran
under a prior release, but this release remains unverified.

## Repository contents

- `rules/` - source markdown for the equipment catalog and references, included intentionally. Editing these is how you change the catalog.
- `data/catalog.json` - the generated catalog, committed intentionally so the module runs without requiring a build step on install.
- `src/`, `tests/`, `scripts/`, `styles/`, `module.json` - the module code, tests, catalog build script, styles, and manifest.
- `graphify-out/` - the local graphify knowledge-graph output. It is **ignored** (see `.gitignore`) and not part of the published module; regenerate it locally with `graphify update .` if you use it.

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
  three precompiled compendium packs (`packs/weapons`, `packs/armor`,
  `packs/shields`) as LevelDB directories, so they are usable immediately on
  install.

The tracked `module.json` in the repository is never modified by the release
process; the `manifest` and `download` fields are stamped only into the staged
release copy. The workflow also guards against publishing a stale catalog: it
rebuilds `data/catalog.json` from `rules/` before packaging and fails the release
if the rebuild changes the committed `data/catalog.json`. That means any change to
`rules/` requires the regenerated catalog to be committed; otherwise the release
fails. The first release is published
automatically once this workflow is merged and pushed to `main`.
