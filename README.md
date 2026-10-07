# Revised Martial Equipment for Foundry VTT

Foundry VTT 14 module for the generated RME catalog and dnd5e 6.0.6 item integration.

## Requirements

- **Node.js 20+** to build the catalog and run the test suite. There are no runtime npm dependencies, so `node` alone is enough to run `npm run build:catalog` and `npm test`.
- **Foundry VTT 14.367+** with the **dnd5e system 6.0.6+**.

## Local development and install

Add the module folder to `Data/modules/foundry-rme` and enable it in the world.

For development, symlink (or copy) this repository into `Data/modules/foundry-rme` so Foundry loads the module straight from your working copy. A symlink works on Linux and macOS; on Windows you may need to copy the folder instead of linking if Foundry does not resolve the link.

After any change to `rules/`, rebuild the generated catalog:

```
npm run build:catalog
```

Run the test suite with:

```
npm test
```

## Usage

GMs can open the catalog from an actor sheet's **RME Catalog** header control; they can import selected entries or the full catalog into the world, or select an owned actor to receive selected entries. Existing catalog Items are detected by `flags.foundry-rme.catalogId` and never overwritten. The `game.rme.openCatalog()` and `game.rme.importCatalog({actor})` APIs remain available.

Owned actor sheets receive an **RME Training** header control. `game.rme.openTraining(actor?)` also opens the training editor: it uses the supplied owned actor when one is given, otherwise the controlled token actor or your character. Group training and explicit per-item overrides are stored on the actor; choosing Untrained is an explicit override, while Inherit uses the group/default resolution. `game.rme.syncActorItems(actor, catalog.equipment, training)` synchronizes supported module-owned fields.

The training dialog also offers optional starting-class training seeding. Choose a class and apply its basic grants; fighter, barbarian, paladin, and ranger require exactly eight eligible weapon categories. This only fills group/item controls that still inherit or are blank, so existing explicit overrides are preserved. Review and save with **Save training** to persist and synchronize. This is a single-class starting-training aid: the monk weapon table is missing, and multiclass, species, and feat training must be handled manually. Selecting a class alone never changes training.

The catalog view contains all 173 equipment entries and 24 reference sections. Source markdown is displayed as escaped preformatted text, not interpreted HTML.

## Automation limitations

Automation is intentionally limited: only unambiguous base damage and training bonus sync. Starting-class training seeding is opt-in; multiclass, ancestry, feats, and tactical effects remain manual.

The module has **not yet been tested in a live Foundry world**. The automated test suite exercises the pure logic and the runtime API surface, but real Foundry/dnd5e rendering and actor interactions are not covered by it.

## Repository contents

- `rules/` - source markdown for the equipment catalog and references, included intentionally. Editing these is how you change the catalog.
- `data/catalog.json` - the generated catalog, committed intentionally so the module runs without requiring a build step on install.
- `src/`, `tests/`, `scripts/`, `styles/`, `module.json` - the module code, tests, catalog build script, styles, and manifest.
- `graphify-out/` - the local graphify knowledge-graph output. It is **ignored** (see `.gitignore`) and not part of the published module; regenerate it locally with `graphify update .` if you use it.

## License

No license is currently supplied. A repository can be publicly visible without a `LICENSE` file, so publishing does not require choosing a license. But absent a `LICENSE` file, reuse of the code and rules remains restricted: the default is "all rights reserved", even though the repo is publicly visible. If you want redistribution and reuse, choose appropriate licenses for both the source code and the bundled `rules/` (they may differ), with the rights holder's approval, and add license notices before inviting reuse.

## Publishing to GitHub

The repository is initialized on the `main` branch. To publish it publicly (after the initial commit is made):

With the GitHub CLI:

```
gh auth login
gh repo create <owner>/foundry-rme --public --source=. --remote=origin --push
```

Or, without the CLI:

1. Create an empty public repository named `foundry-rme` on GitHub's web UI (do not initialize it with a README).
2. Add it as a remote and push:

```
git remote add origin https://github.com/<owner>/foundry-rme.git
git push -u origin main
```

## Releases

No release has been published yet, so the module manifest does not yet carry release URLs. Once you know the repository owner and the release tag/URL, you may add the standard Foundry manifest and download fields to `module.json`:

- `manifest` - the URL Foundry polls for update checks (for a GitHub-hosted module this is typically the raw `module.json` on the `main` branch of the public repository).
- `download` - the URL of a released ZIP archive that installs the module.

For a direct Foundry install from a ZIP, the archive must contain `module.json` at its root (Foundry installs `Data/modules/foundry-rme` from the ZIP root). Ensure the archived content is the module root, not a nested folder.
