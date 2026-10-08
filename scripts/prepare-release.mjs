#!/usr/bin/env node
// prepare-release.mjs
//
// Deterministically builds a Foundry-installable release package for a GitHub
// release without modifying the tracked module.json.
//
// Interface:
//   npm run package:release -- --run-number N --repository OWNER/REPO [--out-dir DIR] [--root DIR]
//
// Behavior:
//   - Validates that N is a positive integer and that OWNER/REPO is a valid
//     owner/repo slug. `--root` overrides the project root (defaults to the
//     repository root) so an isolated fixture can be packaged in tests.
//   - Reads the tracked module.json and requires its `version` to be strict
//     major.minor.patch.
//   - Computes the release version as major.minor.(patch + N), tag `v<version>`.
//   - Stages a copy under OUT_DIR/package/ containing only the module payload:
//       OUT_DIR/package/module.json
//       OUT_DIR/package/src/
//       OUT_DIR/package/styles/
//       OUT_DIR/package/data/catalog.json
//       OUT_DIR/package/packs/weapons/
//       OUT_DIR/package/packs/armor/
//       OUT_DIR/package/packs/shields/
//     The staged manifest is identical to the source except for `version` and
//     the release `manifest`/`download` URLs.
//   - Copies the staged manifest to OUT_DIR/module.json.
//   - Builds OUT_DIR/foundry-rme.zip with module.json directly at the archive
//     root (not under a package/ folder), using the external `zip` executable.
//   - Writes OUT_DIR/release.json { tag, version, repository }.
//
// The three precompiled RME compendium packs are required inputs: each pack
// path must exist and be a compiled LevelDB directory (a CURRENT marker and/or
// .ldb data files), and module.json must declare all three. Only the module
// payload plus the compiled packs are archived, so .git/, rules/,
// graphify-out/, tests/, and any local secrets are excluded by construction.

import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  rmSync,
  copyFileSync,
  readdirSync,
  existsSync,
  statSync,
} from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');

// The three precompiled compendium packs shipped in every release. `name` is
// both the pack directory and the module.json pack name; the path is explicit
// so a future rename cannot silently ship a different layout.
const PACKS = [
  { name: 'weapons', path: 'packs/weapons' },
  { name: 'armor', path: 'packs/armor' },
  { name: 'shields', path: 'packs/shields' },
];

const ZIP_NAME = 'foundry-rme.zip';

function pathsFor(projectRoot) {
  return {
    moduleJson: join(projectRoot, 'module.json'),
    srcDir: join(projectRoot, 'src'),
    stylesDir: join(projectRoot, 'styles'),
    catalogJson: join(projectRoot, 'data', 'catalog.json'),
    packsDir: join(projectRoot, 'packs'),
  };
}

// A GitHub owner/name slug: starts and ends alphanumeric, middle may contain
// alphanumerics, hyphens, underscores, and dots. No empty leading/trailing
// separators, no spaces.
const SLUG = /^[A-Za-z0-9](?:[A-Za-z0-9-._]*[A-Za-z0-9])?$/;

function fail(message) {
  throw new Error(`[prepare-release] ${message}`);
}

function usage() {
  return (
    'usage: npm run package:release -- --run-number N --repository OWNER/REPO [--out-dir DIR] [--root DIR]'
  );
}

function parseRunNumber(value) {
  if (typeof value !== 'string' || !/^[1-9][0-9]*$/.test(value)) {
    fail(`--run-number must be a positive integer, got "${value}"`);
  }
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n < 1) {
    fail(`--run-number must be a positive integer, got "${value}"`);
  }
  return n;
}

function parseRepository(value) {
  if (typeof value !== 'string') {
    fail(`--repository must be OWNER/REPO, got "${value}"`);
  }
  const parts = value.split('/');
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    fail(`--repository must be OWNER/REPO, got "${value}"`);
  }
  const [owner, repo] = parts;
  if (!SLUG.test(owner)) {
    fail(`invalid repository owner "${owner}" (expected a GitHub slug)`);
  }
  if (!SLUG.test(repo)) {
    fail(`invalid repository repo "${repo}" (expected a GitHub slug)`);
  }
  return `${owner}/${repo}`;
}

function parseStrictVersion(value) {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(value);
  if (!m) {
    fail(`module.json version must be strict major.minor.patch, got "${value}"`);
  }
  return {
    major: Number(m[1]),
    minor: Number(m[2]),
    patch: Number(m[3]),
  };
}

function assertDir(path, label) {
  if (!existsSync(path) || !statSync(path).isDirectory()) {
    fail(`${label} directory is missing: ${path}`);
  }
}

function assertFile(path, label) {
  if (!existsSync(path) || !statSync(path).isFile()) {
    fail(`${label} file is missing: ${path}`);
  }
}

function validateCatalog(paths) {
  if (!existsSync(paths.catalogJson)) {
    fail('data/catalog.json is missing; run `npm run build:catalog` first');
  }
  assertFile(paths.catalogJson, 'data/catalog.json');
  let catalog;
  try {
    catalog = JSON.parse(readFileSync(paths.catalogJson, 'utf8'));
  } catch {
    fail('data/catalog.json is not valid JSON; run `npm run build:catalog`');
  }
  if (
    !catalog ||
    !Array.isArray(catalog.equipment) ||
    catalog.equipment.length === 0 ||
    !Array.isArray(catalog.references)
  ) {
    fail('data/catalog.json does not look like a built catalog; run `npm run build:catalog`');
  }
}

// A compiled Foundry compendium pack is a LevelDB directory. The reliable
// markers are the CURRENT file (the LevelDB manifest pointer) and/or the .ldb
// data files. Require at least one of them so an empty or half-built directory
// cannot be packaged as a valid pack.
function assertLevelDBDir(path, label) {
  assertDir(path, label);
  const entries = readdirSync(path);
  const hasCurrent = entries.includes('CURRENT');
  const hasLdb = entries.some((entry) => entry.endsWith('.ldb'));
  if (!hasCurrent && !hasLdb) {
    fail(
      `${label} is not a compiled LevelDB pack (no CURRENT or .ldb file found): ${path}`
    );
  }
}

// The module payload must include every pack we archive. This guards against a
// manifest/path mismatch slipping through to an installable release.
function validatePackManifest(sourceManifest) {
  const declared = new Set(
    (Array.isArray(sourceManifest.packs) ? sourceManifest.packs : []).map(
      (p) => p.path
    )
  );
  for (const pack of PACKS) {
    if (!declared.has(pack.path)) {
      fail(`module.json must declare a pack at ${pack.path}`);
    }
  }
}

// Copies the contents of srcDir into destDir, mirroring the tree exactly.
function copyDirRecursive(srcDir, destDir) {
  mkdirSync(destDir, { recursive: true });
  for (const entry of readdirSync(srcDir, { withFileTypes: true })) {
    const sourcePath = join(srcDir, entry.name);
    const targetPath = join(destDir, entry.name);
    if (entry.isDirectory()) {
      copyDirRecursive(sourcePath, targetPath);
    } else {
      copyFileSync(sourcePath, targetPath);
    }
  }
}

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const raw = argv[i];
    if (raw === '--help' || raw === '-h') {
      args.help = true;
      continue;
    }
    const eq = raw.indexOf('=');
    const name = eq === -1 ? raw : raw.slice(0, eq);
    const inlineValue = eq === -1 ? undefined : raw.slice(eq + 1);

    let value;
    switch (name) {
      case '--run-number':
      case '--repository':
      case '--out-dir':
      case '--root':
        value = inlineValue !== undefined ? inlineValue : argv[++i];
        if (value === undefined) {
          fail(`${name} requires a value\n${usage()}`);
        }
        break;
      default:
        fail(`unknown argument: ${raw}\n${usage()}`);
    }

    if (name === '--run-number') args.runNumber = value;
    else if (name === '--repository') args.repository = value;
    else if (name === '--out-dir') args.outDir = value;
    else if (name === '--root') args.root = value;
  }
  return args;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(usage());
    return;
  }

  if (args.runNumber === undefined) {
    fail(`missing required --run-number\n${usage()}`);
  }
  if (args.repository === undefined) {
    fail(`missing required --repository\n${usage()}`);
  }

  const runNumber = parseRunNumber(args.runNumber);
  const repository = parseRepository(args.repository);

  // `--root` lets an isolated fixture be packaged (tests); it defaults to the
  // repository root so normal releases are unchanged.
  const projectRoot = args.root
    ? resolve(process.cwd(), args.root)
    : ROOT;
  const paths = pathsFor(projectRoot);

  // Source manifest must exist and be strict semver before we derive anything.
  assertFile(paths.moduleJson, 'module.json');
  let sourceManifest;
  try {
    sourceManifest = JSON.parse(readFileSync(paths.moduleJson, 'utf8'));
  } catch {
    fail('module.json is not valid JSON');
  }
  const { major, minor, patch } = parseStrictVersion(sourceManifest.version);

  const releaseVersion = `${major}.${minor}.${patch + runNumber}`;
  const tag = `v${releaseVersion}`;

  const manifestUrl = `https://github.com/${repository}/releases/latest/download/module.json`;
  const downloadUrl = `https://github.com/${repository}/releases/download/${tag}/${ZIP_NAME}`;

  // The packaged data must reflect a built catalog and a manifest that declares
  // (and is consistent with) the compiled packs we are about to ship.
  assertDir(paths.srcDir, 'src');
  assertDir(paths.stylesDir, 'styles');
  validateCatalog(paths);
  validatePackManifest(sourceManifest);

  // Every pack must exist and be an actual compiled LevelDB directory. This
  // enforces the `npm run build:packs` prerequisite at the packaging gate so a
  // release can never silently omit the compendium packs.
  for (const pack of PACKS) {
    assertLevelDBDir(join(paths.packsDir, pack.name), pack.path);
  }

  const outDir = args.outDir
    ? resolve(process.cwd(), args.outDir)
    : join(projectRoot, 'dist');
  const packageDir = join(outDir, 'package');
  const stagedManifest = join(packageDir, 'module.json');
  const distManifest = join(outDir, 'module.json');
  const zipPath = join(outDir, ZIP_NAME);
  const releasePath = join(outDir, 'release.json');

  // Deterministic rebuild: clear the artifacts we own, then recreate.
  rmSync(packageDir, { recursive: true, force: true });
  rmSync(distManifest, { force: true });
  rmSync(zipPath, { force: true });
  rmSync(releasePath, { force: true });
  mkdirSync(packageDir, { recursive: true });

  // Stage the manifest: identical to source except version and the release URLs.
  const staged = {
    ...sourceManifest,
    version: releaseVersion,
    manifest: manifestUrl,
    download: downloadUrl,
  };
  writeFileSync(
    stagedManifest,
    `${JSON.stringify(staged, null, 2)}\n`,
    'utf8'
  );

  copyDirRecursive(paths.srcDir, join(packageDir, 'src'));
  copyDirRecursive(paths.stylesDir, join(packageDir, 'styles'));
  mkdirSync(join(packageDir, 'data'), { recursive: true });
  copyFileSync(paths.catalogJson, join(packageDir, 'data', 'catalog.json'));

  // Stage the compiled compendium packs under package/packs/<name> so they are
  // archived alongside the rest of the module payload.
  mkdirSync(join(packageDir, 'packs'), { recursive: true });
  for (const pack of PACKS) {
    copyDirRecursive(
      join(paths.packsDir, pack.name),
      join(packageDir, 'packs', pack.name)
    );
  }

  // Provide the standalone manifest alongside the package staging area.
  copyFileSync(stagedManifest, distManifest);

  // Archive from the package dir so module.json lands at the archive root,
  // not under a package/ folder. Only the module payload and compiled packs
  // are zipped.
  try {
    execFileSync(
      'zip',
      ['-r', zipPath, 'module.json', 'src', 'styles', 'data', 'packs'],
      {
        cwd: packageDir,
        stdio: ['ignore', 'pipe', 'pipe'],
        encoding: 'utf8',
      }
    );
  } catch (err) {
    if (err.code === 'ENOENT') {
      fail(
        'the `zip` executable was not found on PATH; install it (e.g. `apt-get install zip`) and retry'
      );
    }
    throw err;
  }

  const release = { tag, version: releaseVersion, repository };
  writeFileSync(
    releasePath,
    `${JSON.stringify(release, null, 2)}\n`,
    'utf8'
  );

  console.log(`staged manifest:    ${stagedManifest}`);
  console.log(`manifest copy:      ${distManifest}`);
  console.log(`archive:            ${zipPath}`);
  console.log(`release.json:       ${releasePath}`);
  console.log(`release version:    ${releaseVersion} (tag ${tag})`);
  console.log(`repository:         ${repository}`);
  console.log('archive contents (module.json at root, src, styles, data/catalog.json, packs/{weapons,armor,shields}):');
  execFileSync('zip', ['-sf', zipPath], {
    stdio: 'inherit',
  });
}

main();
