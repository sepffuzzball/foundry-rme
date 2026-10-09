import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const WORKFLOW = join(ROOT, '.github', 'workflows', 'release.yml');

function workflowText() {
  assert.ok(existsSync(WORKFLOW), '.github/workflows/release.yml must exist');
  const stat = statSync(WORKFLOW);
  assert.ok(stat.isFile(), '.github/workflows/release.yml must be a file');
  return readFileSync(WORKFLOW, 'utf8');
}

test('release workflow exists and is non-empty', () => {
  const text = workflowText();
  assert.ok(text.trim().length > 0, 'workflow file must not be empty');
});

test('workflow triggers on every push to main', () => {
  const text = workflowText();
  assert.match(text, /^on:\s*$/m, 'must declare an `on:` trigger');
  assert.match(text, /^[ \t]+push:\s*$/m, 'must trigger on push');
  assert.match(text, /branches:\s*\[main\]/, 'must target the main branch');
});

test('workflow grants only the minimal contents: write permission', () => {
  const text = workflowText();
  const block = /^permissions:\s*$/m.test(text);
  assert.ok(block, 'must declare a permissions block');
  assert.match(text, /contents:\s*write/, 'must grant contents: write');
});

test('workflow supplies GH_TOKEN from the built-in github token', () => {
  const text = workflowText();
  assert.match(text, /GH_TOKEN:/, 'must set GH_TOKEN');
  assert.ok(
    text.includes('GH_TOKEN: ${{ github.token }}'),
    'GH_TOKEN must come from the built-in github.token (no personal secrets)'
  );
});

test('workflow checks out and sets up Node 20', () => {
  const text = workflowText();
  assert.ok(text.includes('uses: actions/checkout@v4'), 'must use checkout@v4');
  assert.ok(text.includes('uses: actions/setup-node@v4'), 'must use setup-node@v4');
  assert.match(text, /node-version:\s*20/, 'must pin Node 20');
});

test('workflow rebuilds the catalog and fails on a stale committed catalog', () => {
  const text = workflowText();
  assert.ok(text.includes('npm run build:catalog'), 'must rebuild the catalog');
  assert.ok(
    text.includes('git diff --exit-code -- data/catalog.json'),
    'must fail when the committed catalog is stale'
  );
});

test('workflow runs the test suite before packaging', () => {
  const text = workflowText();
  assert.ok(text.includes('npm test'), 'must run the test suite');
});

test('workflow compiles the compendium packs before packaging', () => {
  const text = workflowText();
  assert.ok(text.includes('npm run build:packs'), 'must build the compendium packs');

  const packsStep = text.indexOf('npm run build:packs');
  const packageStep = text.indexOf('npm run package:release');
  assert.ok(packsStep !== -1, 'build:packs step must be present');
  assert.ok(packageStep !== -1, 'package:release step must be present');
  assert.ok(
    packsStep < packageStep,
    'build:packs must run before package:release'
  );
});

test('workflow packages the release with the run number and repository', () => {
  const text = workflowText();
  assert.ok(
    text.includes(
      'npm run package:release -- --run-number "$GITHUB_RUN_NUMBER" --repository "$GITHUB_REPOSITORY"'
    ),
    'must pass the run number and repository to package:release'
  );
});

test('workflow verifies the archive root, catalog, and compendium packs via unzip', () => {
  const text = workflowText();
  assert.ok(text.includes('unzip'), 'must invoke unzip to list the archive');
  assert.ok(text.includes("'-Z'") && text.includes("'-1'"), 'must use unzip -Z -1');
  assert.ok(
    text.includes("assert.ok(listing.includes('module.json')"),
    'must assert module.json at archive root'
  );
  assert.ok(
    text.includes("assert.ok(listing.includes('data/catalog.json')"),
    'must assert data/catalog.json is archived'
  );
  // The archived compendium packs and their LevelDB records must be verified.
  assert.ok(
    text.includes("['weapons', 'armor', 'shields', 'ammunition']"),
    'must iterate the four compiled packs'
  );
  assert.ok(
    text.includes('listing.includes(`${prefix}CURRENT`)'),
    'must assert the pack CURRENT marker is archived'
  );
  assert.ok(
    text.includes("listing.some((l) => l.startsWith(prefix) && l.endsWith('.ldb'))"),
    'must assert a LevelDB .ldb file is archived'
  );
});

test('workflow verifies the bundled icons, attribution, and icon count via unzip', () => {
  const text = workflowText();
  assert.ok(
    text.includes("listing.includes('ICON_ATTRIBUTION.md')"),
    'must assert ICON_ATTRIBUTION.md is archived'
  );
  assert.ok(
    text.includes("listing.includes('data/icon-map.json')"),
    'must assert data/icon-map.json is archived'
  );
  assert.ok(
    text.includes("l.startsWith('assets/icons/') && l.endsWith('.svg')"),
    'must list the archived icons under assets/icons/'
  );
  assert.ok(
    text.includes('iconAssets.length > 0'),
    'must require at least one bundled icon'
  );
  assert.ok(
    text.includes('referencedIcons.size'),
    'must compare the archived icon count to the icon map'
  );
  assert.ok(
    text.includes('archived icon count must match the icon map'),
    'must fail on an icon count mismatch'
  );
  assert.ok(
    text.includes('unzip'),
    'must invoke unzip to inspect the archive'
  );
});

test('workflow verifies the staged manifest URLs, tag, and version', () => {
  const text = workflowText();
  assert.ok(text.includes('dist/release.json'), 'must read dist/release.json');
  assert.ok(
    text.includes('https://github.com/${repo}/releases/latest/download/module.json'),
    'must pin the latest-download manifest URL'
  );
  assert.ok(
    text.includes('https://github.com/${repo}/releases/download/${tag}/foundry-rme.zip'),
    'must pin the tag-scoped download URL'
  );
  assert.ok(
    text.includes('assert.deepEqual(zipManifest, distManifest'),
    'must assert the archived manifest equals the staged manifest'
  );
});

test('workflow creates the release with the exact tag and nonlatest target', () => {
  const text = workflowText();
  assert.ok(text.includes('gh release create'), 'must create a release');
  assert.ok(text.includes('--target "$GITHUB_SHA"'), 'must target the push SHA');
  assert.ok(text.includes('--latest=false'), 'must create as nonlatest');
  assert.ok(text.includes('--generate-notes'), 'must generate release notes');
  assert.ok(
    text.includes('dist/module.json dist/foundry-rme.zip'),
    'must attach the manifest and the ZIP'
  );
});

test('workflow supports reruns without clobbering existing assets', () => {
  const text = workflowText();
  assert.ok(text.includes('gh release upload'), 'must upload missing assets');
  assert.ok(text.includes('targetCommitish'), 'must verify the existing release target');
  assert.ok(
    text.includes('has zero size; refusing to proceed'),
    'must fail on zero-size existing assets'
  );
});

test('workflow marks the release latest only when main still points at this SHA', () => {
  const text = workflowText();
  assert.ok(text.includes('gh release edit "$TAG" --latest'), 'must edit to latest');
  assert.ok(text.includes('repos/$GITHUB_REPOSITORY/branches/main'), 'must read main head');
  assert.ok(text.includes('--jq .commit.sha'), 'must read the main head SHA');
  assert.ok(text.includes('leaving $TAG nonlatest'), 'must leave nonlatest on mismatch');
});
