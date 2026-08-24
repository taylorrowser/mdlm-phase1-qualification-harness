import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

const cli = path.resolve('bin/mdlm-phase1-qualify.mjs');
const bindings = {
  runner: 'bin/runner.mjs', configuration: 'config/qualification.json',
  fixtures: ['fixtures/conforming.mjs'], oracles: ['lib/oracle.mjs'],
  probes: ['probes/node24.mjs'], profiles: ['profiles/calculator.json'],
};
const assets = Object.values(bindings).flat();
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

function makeEnvironment(change = () => {}, alterManifest = () => {}) {
  const localBindings = structuredClone(bindings);
  const root = mkdtempSync(path.join(tmpdir(), 'phase1-assets-'));
  git(root, 'init', '-q');
  git(root, 'config', 'user.name', 'Test');
  git(root, 'config', 'user.email', 'test@example.invalid');
  for (const asset of assets) mkdirSync(path.dirname(path.join(root, asset)), { recursive: true });
  writeFileSync(path.join(root, bindings.runner), '#!/usr/bin/env node\nif(process.argv[2]!=="self-check")process.exit(2);process.stdout.write("ok\\n");\n');
  chmodSync(path.join(root, bindings.runner), 0o755);
  writeFileSync(path.join(root, bindings.configuration), `${JSON.stringify({ schemaVersion: 1, bindings: localBindings })}\n`);
  for (const asset of assets.filter((item) => ![bindings.runner, bindings.configuration].includes(item))) writeFileSync(path.join(root, asset), '{}\n');
  change(root);
  const manifestAssets = assets.map((asset) => {
    const bytes = readFileSync(path.join(root, asset));
    return {
      path: asset,
      mode: asset === bindings.runner ? '100755' : '100644',
      gitBlob: git(root, 'hash-object', asset),
      sha256: createHash('sha256').update(bytes).digest('hex'),
    };
  });
  alterManifest(manifestAssets);
  writeFileSync(path.join(root, 'manifest.json'), `${JSON.stringify({ schemaVersion: 1, bindings: localBindings, assets: manifestAssets })}\n`);
  git(root, 'add', '.');
  git(root, 'commit', '-qm', 'qualification environment');
  const environment = { repository: root, commit: git(root, 'rev-parse', 'HEAD'), tree: git(root, 'rev-parse', 'HEAD^{tree}') };
  const env = { schemaVersion: 1, environment, manifestPath: 'manifest.json', entrypoint: { path: localBindings.runner, argv: ['self-check'] }, bindings: structuredClone(localBindings) };
  const vai = { schemaVersion: 1, environment: structuredClone(environment), manifestPath: 'manifest.json', bindings: structuredClone(localBindings) };
  const envPath = path.join(root, 'env.json');
  const vaiPath = path.join(root, 'vai.json');
  writeFileSync(envPath, JSON.stringify(env));
  writeFileSync(vaiPath, JSON.stringify(vai));
  return { root, env, vai, envPath, vaiPath };
}

function invoke(fixture, temporaryRoot) {
  return spawnSync(process.execPath, [cli, 'preflight', '--env', fixture.envPath, '--vai', fixture.vaiPath], {
    encoding: 'utf8', env: { ...process.env, TMPDIR: temporaryRoot },
  });
}

test('preflight verifies a complete immutable environment and always removes its checkout', () => {
  const fixture = makeEnvironment();
  const scratch = mkdtempSync(path.join(tmpdir(), 'phase1-preflight-cleanup-'));
  try {
    const result = invoke(fixture, scratch);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(readdirSync(scratch), []);
  } finally { rmSync(fixture.root, { recursive: true, force: true }); rmSync(scratch, { recursive: true, force: true }); }
});

test('preflight rejects manifest tampering and unresolved proposals', () => {
  const fixture = makeEnvironment();
  const scratch = mkdtempSync(path.join(tmpdir(), 'phase1-preflight-tamper-'));
  try {
    fixture.vai.bindings.runner = '$proposal.runner';
    writeFileSync(fixture.vaiPath, JSON.stringify(fixture.vai));
    const proposal = invoke(fixture, scratch);
    assert.equal(proposal.status, 1);
    assert.match(proposal.stderr, /unresolved \$proposal/);
    fixture.vai.bindings.runner = bindings.runner;
    writeFileSync(fixture.vaiPath, JSON.stringify(fixture.vai));
    fixture.env.environment.tree = '0'.repeat(40);
    fixture.vai.environment.tree = '0'.repeat(40);
    writeFileSync(fixture.envPath, JSON.stringify(fixture.env));
    writeFileSync(fixture.vaiPath, JSON.stringify(fixture.vai));
    const tamper = invoke(fixture, scratch);
    assert.equal(tamper.status, 1);
    assert.match(tamper.stderr, /resolved tree/);
    assert.deepEqual(readdirSync(scratch), []);
  } finally { rmSync(fixture.root, { recursive: true, force: true }); rmSync(scratch, { recursive: true, force: true }); }
});

test('preflight rejects raw-byte digest tampering', () => {
  const fixture = makeEnvironment(() => {}, (manifestAssets) => { manifestAssets[0].sha256 = '0'.repeat(64); });
  const scratch = mkdtempSync(path.join(tmpdir(), 'phase1-preflight-digest-'));
  try {
    const result = invoke(fixture, scratch);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /SHA-256 mismatch/);
    assert.deepEqual(readdirSync(scratch), []);
  } finally { rmSync(fixture.root, { recursive: true, force: true }); rmSync(scratch, { recursive: true, force: true }); }
});

test('preflight rejects path escape and symlink assets', () => {
  const fixture = makeEnvironment();
  const scratch = mkdtempSync(path.join(tmpdir(), 'phase1-preflight-path-'));
  try {
    fixture.vai.bindings.runner = '../runner.mjs';
    fixture.env.bindings.runner = '../runner.mjs';
    writeFileSync(fixture.vaiPath, JSON.stringify(fixture.vai));
    writeFileSync(fixture.envPath, JSON.stringify(fixture.env));
    const escape = invoke(fixture, scratch);
    assert.equal(escape.status, 1);
    assert.match(escape.stderr, /escapes the environment/);
  } finally { rmSync(fixture.root, { recursive: true, force: true }); rmSync(scratch, { recursive: true, force: true }); }

  const linked = makeEnvironment((root) => {
    rmSync(path.join(root, 'lib/oracle.mjs'));
    symlinkSync('../profiles/calculator.json', path.join(root, 'lib/oracle.mjs'));
  });
  const linkedScratch = mkdtempSync(path.join(tmpdir(), 'phase1-preflight-link-'));
  try {
    const result = invoke(linked, linkedScratch);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /symlink/);
  } finally { rmSync(linked.root, { recursive: true, force: true }); rmSync(linkedScratch, { recursive: true, force: true }); }
});
