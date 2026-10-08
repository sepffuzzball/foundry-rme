import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  mkdtempSync,
  rmSync,
  readFileSync,
  readdirSync,
  existsSync,
  copyFileSync,
  mkdirSync,
  cpSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildPacks } from '../scripts/build-packs.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const SCRIPT = join(__dirname, '..', 'scripts', 'prepare-release.mjs');
const TRACKED_MANIFEST = join(ROOT, 'module.json');

const REPOSITORY = 'sepffuzzball/foundry-rme';
const BASE_VERSION = '0.1.0';
const RELEASE_URL_BASE = `https://github.com/${REPOSITORY}`;

// The four precompiled packs that every installable release must carry, along
// with the LevelDB markers we require in the archive.
const PACKS = ['weapons', 'armor', 'shields', 'ammunition'];

// Sentinel for "do not pass this argument at all", so the value `undefined` can
// still mean "use the default" elsewhere without accidentally omitting the flag.
const OMIT = Symbol('omit');

// Runs the release script against a given out-dir and returns whether it
// succeeded. Set expectFailure and assert on res.ok instead of letting it throw.
function runRelease({
  outDir,
  root,
  runNumber = '1',
  repository = REPOSITORY,
  expectFailure = false,
}) {
  const args = [SCRIPT];
  if (runNumber !== OMIT) args.push('--run-number', String(runNumber));
  if (repository !== OMIT) args.push('--repository', repository);
  if (root !== undefined) args.push('--root', root);
  if (outDir !== undefined) args.push('--out-dir', outDir);
  try {
    execFileSync(process.execPath, args, {
      cwd: ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    if (expectFailure) return { ok: false, output: '', status: 0 };
    return { ok: true, output: '' };
  } catch (err) {
    if (!expectFailure) throw err;
    return {
      ok: false,
      output: `${err.stdout || ''}${err.stderr || ''}`,
      status: err.status,
    };
  }
}

// Creates an isolated temp out-dir, runs fn with it, and always cleans up.
function withTempOut(fn) {
  const outDir = mkdtempSync(join(tmpdir(), 'foundry-rme-release-'));
  try {
    return fn(outDir);
  } finally {
    rmSync(outDir, { recursive: true, force: true });
  }
}

function zipLines(zipPath) {
  const out = execFileSync('unzip', ['-Z', '-1', zipPath], {
    encoding: 'utf8',
  });
  return out
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
}

function readJson(filePath) {
  return JSON.parse(readFileSync(filePath, 'utf8'));
}

// Build a self-contained module root for a release test. It carries its own
// copy of the module payload (module.json, src, styles, data/catalog.json) and
// the three compiled compendium packs produced by `buildPacks`, so the release
// script can be exercised without depending on (or racing with) the tracked
// `packs/` directory that npm test's other files also compile.
async function makeFixtureRoot() {
  const root = mkdtempSync(join(tmpdir(), 'foundry-rme-packs-fixture-'));

  copyFileSync(TRACKED_MANIFEST, join(root, 'module.json'));
  cpSync(join(ROOT, 'src'), join(root, 'src'), { recursive: true });
  cpSync(join(ROOT, 'styles'), join(root, 'styles'), { recursive: true });
  mkdirSync(join(root, 'data'), { recursive: true });
  copyFileSync(join(ROOT, 'data', 'catalog.json'), join(root, 'data', 'catalog.json'));
  copyFileSync(join(ROOT, 'data', 'ammunition.json'), join(root, 'data', 'ammunition.json'));

  await buildPacks({ root });
  return root;
}

let fixtureRoot;

before(async () => {
  fixtureRoot = await makeFixtureRoot();
});

after(() => {
  rmSync(fixtureRoot, { recursive: true, force: true });
});

test('release manifest carries the computed version and the release URLs', () => {
  withTempOut((outDir) => {
    runRelease({ outDir, root: fixtureRoot, runNumber: '1' });
    const manifest = readJson(join(outDir, 'module.json'));
    assert.equal(manifest.version, '0.1.1');
    assert.equal(
      manifest.manifest,
      `${RELEASE_URL_BASE}/releases/latest/download/module.json`
    );
    assert.equal(
      manifest.download,
      `${RELEASE_URL_BASE}/releases/download/v0.1.1/foundry-rme.zip`
    );
    assert.equal(manifest.id, 'foundry-rme');
  });
});

test('release version increments the patch by the run number', () => {
  withTempOut((outDir) => {
    runRelease({ outDir, root: fixtureRoot, runNumber: '3' });
    const manifest = readJson(join(outDir, 'module.json'));
    assert.equal(manifest.version, '0.1.3');
    assert.equal(
      manifest.download,
      `${RELEASE_URL_BASE}/releases/download/v0.1.3/foundry-rme.zip`
    );
  });
});

test('package staging area contains only the module payload', () => {
  withTempOut((outDir) => {
    runRelease({ outDir, root: fixtureRoot });
    const pkg = join(outDir, 'package');
    assert.ok(existsSync(join(pkg, 'module.json')), 'package/module.json');
    assert.ok(existsSync(join(pkg, 'src', 'main.mjs')), 'package/src/main.mjs');
    assert.ok(existsSync(join(pkg, 'src', 'items.mjs')), 'package/src/items.mjs');
    assert.ok(existsSync(join(pkg, 'styles', 'rme.css')), 'package/styles/rme.css');
    assert.ok(
      existsSync(join(pkg, 'data', 'catalog.json')),
      'package/data/catalog.json'
    );
    assert.ok(
      existsSync(join(pkg, 'data', 'ammunition.json')),
      'package/data/ammunition.json'
    );

    // The compiled compendium packs are part of the module payload.
    for (const pack of PACKS) {
      assert.ok(
        existsSync(join(pkg, 'packs', pack, 'CURRENT')),
        `package/packs/${pack}/CURRENT`
      );
      assert.ok(
        readdirSync(join(pkg, 'packs', pack)).some((f) => f.endsWith('.ldb')),
        `package/packs/${pack} must contain a LevelDB .ldb file`
      );
    }

    const top = readdirSync(pkg).sort();
    assert.deepEqual(top, ['data', 'module.json', 'packs', 'src', 'styles']);

    // Non-module sources must not be staged.
    assert.ok(!existsSync(join(pkg, 'rules')));
    assert.ok(!existsSync(join(pkg, '.git')));
    assert.ok(!existsSync(join(pkg, 'graphify-out')));
    assert.ok(!existsSync(join(pkg, 'tests')));
  });
});

test('copies the staged manifest to the out-dir root', () => {
  withTempOut((outDir) => {
    runRelease({ outDir, root: fixtureRoot });
    const staged = readJson(join(outDir, 'package', 'module.json'));
    const dist = readJson(join(outDir, 'module.json'));
    assert.deepEqual(dist, staged);
  });
});

test('archive lists module.json at root, including runtime, catalog, and packs', () => {
  withTempOut((outDir) => {
    runRelease({ outDir, root: fixtureRoot });
    const lines = zipLines(join(outDir, 'foundry-rme.zip'));

    // module.json must be at the archive root, never under package/.
    assert.ok(lines.includes('module.json'), 'module.json at archive root');
    assert.ok(!lines.includes('package/module.json'), 'no package/ prefix');

    // The module runtime, styles, and generated data files are all present.
    assert.ok(lines.includes('src/main.mjs'), 'runtime included');
    assert.ok(lines.includes('styles/rme.css'), 'styles included');
    assert.ok(lines.includes('data/catalog.json'), 'catalog included');
    assert.ok(lines.includes('data/ammunition.json'), 'ammunition included');

    // Every compiled pack directory with its LevelDB records must be present.
    for (const pack of PACKS) {
      assert.ok(
        lines.includes(`packs/${pack}/CURRENT`),
        `packs/${pack}/CURRENT archived`
      );
      assert.ok(
        lines.some(
          (l) => l.startsWith(`packs/${pack}/`) && l.endsWith('.ldb')
        ),
        `packs/${pack} must contain a LevelDB .ldb file`
      );
    }
  });
});

test('archive excludes rules, graphify-out, tests, .git, and secrets', () => {
  withTempOut((outDir) => {
    runRelease({ outDir, root: fixtureRoot });
    const lines = zipLines(join(outDir, 'foundry-rme.zip'));

    assert.ok(
      !lines.some((l) => l.startsWith('rules/')),
      'rules/ excluded from archive'
    );
    assert.ok(
      !lines.some((l) => l.startsWith('graphify-out/')),
      'graphify-out/ excluded from archive'
    );
    assert.ok(
      !lines.some((l) => l.startsWith('tests/')),
      'tests/ excluded from archive'
    );
    assert.ok(
      !lines.some((l) => l.startsWith('.git') || l.startsWith('package/')),
      '.git and package/ excluded from archive'
    );
  });
});

test('tracked module.json is not modified by the release script', () => {
  const before = readFileSync(TRACKED_MANIFEST, 'utf8');
  withTempOut((outDir) => {
    runRelease({ outDir, root: fixtureRoot });
  });
  const after = readFileSync(TRACKED_MANIFEST, 'utf8');
  assert.equal(after, before);

  const manifest = JSON.parse(before);
  assert.equal(manifest.version, BASE_VERSION);
  assert.equal('manifest' in manifest, false);
  assert.equal('download' in manifest, false);
});

test('release.json records tag, version, and repository only', () => {
  withTempOut((outDir) => {
    runRelease({ outDir, root: fixtureRoot, runNumber: '2' });
    const release = readJson(join(outDir, 'release.json'));
    assert.equal(release.tag, 'v0.1.2');
    assert.equal(release.version, '0.1.2');
    assert.equal(release.repository, REPOSITORY);
    assert.deepEqual(Object.keys(release).sort(), ['repository', 'tag', 'version']);
  });
});

test('rejects when a compiled pack is missing', () => {
  withTempOut((outDir) => {
    // Point at the fixture root without any packs in it.
    const bareRoot = mkdtempSync(join(tmpdir(), 'foundry-rme-no-packs-'));
    try {
      copyFileSync(TRACKED_MANIFEST, join(bareRoot, 'module.json'));
      cpSync(join(ROOT, 'src'), join(bareRoot, 'src'), { recursive: true });
      cpSync(join(ROOT, 'styles'), join(bareRoot, 'styles'), { recursive: true });
      mkdirSync(join(bareRoot, 'data'), { recursive: true });
      copyFileSync(
        join(ROOT, 'data', 'catalog.json'),
        join(bareRoot, 'data', 'catalog.json')
      );
      copyFileSync(
        join(ROOT, 'data', 'ammunition.json'),
        join(bareRoot, 'data', 'ammunition.json')
      );

      const res = runRelease({
        outDir,
        root: bareRoot,
        runNumber: '1',
        expectFailure: true,
      });
      assert.equal(res.ok, false, 'packaging must fail without compiled packs');
      assert.notEqual(res.status, 0);
      assert.match(
        res.output,
        /directory is missing|compiled LevelDB pack/i,
        'failure must name the missing or unbuilt pack'
      );
    } finally {
      rmSync(bareRoot, { recursive: true, force: true });
    }
  });
});

test('rejects when data/ammunition.json is missing', () => {
  withTempOut((outDir) => {
    // Point at a fixture root that has the catalog but omits ammunition.json.
    const bareRoot = mkdtempSync(join(tmpdir(), 'foundry-rme-no-ammo-'));
    try {
      copyFileSync(TRACKED_MANIFEST, join(bareRoot, 'module.json'));
      cpSync(join(ROOT, 'src'), join(bareRoot, 'src'), { recursive: true });
      cpSync(join(ROOT, 'styles'), join(bareRoot, 'styles'), { recursive: true });
      mkdirSync(join(bareRoot, 'data'), { recursive: true });
      copyFileSync(
        join(ROOT, 'data', 'catalog.json'),
        join(bareRoot, 'data', 'catalog.json')
      );

      const res = runRelease({
        outDir,
        root: bareRoot,
        runNumber: '1',
        expectFailure: true,
      });
      assert.equal(
        res.ok,
        false,
        'packaging must fail without data/ammunition.json'
      );
      assert.notEqual(res.status, 0);
      assert.match(
        res.output,
        /ammunition\.json/i,
        'failure must name the missing ammunition file'
      );
    } finally {
      rmSync(bareRoot, { recursive: true, force: true });
    }
  });
});

test('rejects an invalid --run-number', () => {
  const bad = ['0', '-1', 'abc', '1.5', ''];
  for (const runNumber of bad) {
    withTempOut((outDir) => {
      const res = runRelease({
        outDir,
        root: fixtureRoot,
        runNumber,
        expectFailure: true,
      });
      assert.equal(res.ok, false, `--run-number ${runNumber} must fail`);
      assert.notEqual(res.status, 0);
      assert.match(res.output, /run-number/i, 'failure names the run-number');
    });
  }
});

test('rejects an invalid --repository', () => {
  const bad = [
    'owneronly',
    '/repo',
    'owner/',
    'owner/repo/extra',
    'Owner/Repo Two',
    'owner repo',
  ];
  for (const repository of bad) {
    withTempOut((outDir) => {
      const res = runRelease({
        outDir,
        root: fixtureRoot,
        repository,
        expectFailure: true,
      });
      assert.equal(res.ok, false, `--repository ${repository} must fail`);
      assert.notEqual(res.status, 0);
    });
  }
});

test('rejects when required arguments are missing', () => {
  withTempOut((outDir) => {
    const missingRepo = runRelease({
      outDir,
      root: fixtureRoot,
      repository: OMIT,
      expectFailure: true,
    });
    assert.equal(missingRepo.ok, false);
    assert.notEqual(missingRepo.status, 0);

    const missingRun = runRelease({
      outDir,
      root: fixtureRoot,
      runNumber: OMIT,
      expectFailure: true,
    });
    assert.equal(missingRun.ok, false);
    assert.notEqual(missingRun.status, 0);
  });
});
