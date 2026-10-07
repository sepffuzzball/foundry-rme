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

Note for installs copied by hand: if you previously installed the module by
copying the `foundry-rme` folder into `Data/modules`, that install is not tied to
a manifest URL, so Foundry will not offer updates for it. To switch to
release-based installs, uninstall the module (or remove the copied folder) and
reinstall it from the manifest URL above. While the module is absent the
module-provided packs and files become unavailable, but Items you imported into
the world generally remain. Still, back up your world before switching, and
reinstall the module before opening the world again so no referenced content is
missing.

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
  archive root (not under a `package/` folder) as Foundry requires.

The tracked `module.json` in the repository is never modified by the release
process; the `manifest` and `download` fields are stamped only into the staged
release copy. The workflow also guards against publishing a stale catalog: it
rebuilds `data/catalog.json` from `rules/` before packaging and fails the release
if the rebuild changes the committed `data/catalog.json`. That means any change to
`rules/` requires the regenerated catalog to be committed; otherwise the release
fails. The first release is published
automatically once this workflow is merged and pushed to `main`.
