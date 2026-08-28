import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { isDeepStrictEqual } from 'node:util';

const root = path.resolve('.');
const command = path.join(root, 'bin/mdlm-phase1-qualify.mjs');
const config = path.join(root, 'config/capability-controls.json');
const manifest = path.join(root, 'manifest.json');
const git = (...args) => execFileSync('/usr/bin/git', args, { cwd: root, encoding: 'utf8' }).trim();
const capabilities = [
  'phase1.exact-role-bindings',
  'phase1.process-contract-oracle',
  'phase1.fixed-identity-authentication',
  'phase1.deterministic-cleanup',
  'phase1.calculator-temperature-oracle',
].sort();

function digestBytes(bytes) {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

function digestFile(file) {
  return digestBytes(readFileSync(file));
}

function gitBlob(file) {
  const bytes = readFileSync(file);
  return createHash('sha1').update(Buffer.from(`blob ${bytes.length}\0`)).update(bytes).digest('hex');
}

function makeFixture(harnessRoot = root) {
  const temporary = mkdtempSync(path.join(tmpdir(), 'phase1-capability-controls-'));
  const commonAsset = path.join(harnessRoot, 'LICENSE');
  const harnessGit = (...args) => execFileSync('/usr/bin/git', args, { cwd: harnessRoot, encoding: 'utf8' }).trim();
  const identity = {
    schemaVersion: 2,
    id: 'capability-controls-test-identity',
    mdlm: { commit: '1'.repeat(40), tree: '2'.repeat(40) },
    runner: {
      commit: '3'.repeat(40), tree: '4'.repeat(40),
      executable: commonAsset, executableSha256: digestFile(commonAsset),
    },
    processPackage: { name: 'mdlm-bootstrap', version: '1.0.0', digest: `sha256:${'5'.repeat(64)}` },
    tooling: {
      manifest: commonAsset, manifestSha256: digestFile(commonAsset),
      lockfile: commonAsset, lockfileSha256: digestFile(commonAsset),
    },
    artifacts: {
      manifest: commonAsset, manifestSha256: digestFile(commonAsset),
      mdlmTarball: commonAsset, mdlmTarballSha256: digestFile(commonAsset),
      mdlmPiTarball: commonAsset, mdlmPiTarballSha256: digestFile(commonAsset),
    },
    harness: {
      commit: harnessGit('rev-parse', 'HEAD^{commit}'),
      tree: harnessGit('rev-parse', 'HEAD^{tree}'),
      qualificationManifest: path.join(harnessRoot, 'manifest.json'),
      qualificationManifestSha256: digestFile(path.join(harnessRoot, 'manifest.json')),
      configurationSha256: digestFile(path.join(harnessRoot, 'config/qualification.json')),
    },
    runtime: {
      executable: process.execPath,
      executableSha256: digestFile(process.execPath),
      nodeVersion: process.versions.node,
    },
  };
  const identityPath = path.join(temporary, 'identity.json');
  const output = path.join(temporary, 'controls.json');
  writeFileSync(identityPath, `${JSON.stringify(identity, null, 2)}\n`);
  return { temporary, harnessRoot, identity, identityPath, identitySha256: digestFile(identityPath), output };
}

function invoke(fixture, overrides = {}) {
  const harnessCommand = path.join(fixture.harnessRoot, 'bin/mdlm-phase1-qualify.mjs');
  const result = spawnSync(process.execPath, [
    harnessCommand, 'capability-controls',
    '--config', overrides.config ?? path.join(fixture.harnessRoot, 'config/capability-controls.json'),
    '--identity', fixture.identityPath,
    '--identity-sha256', overrides.identitySha256 ?? fixture.identitySha256,
    '--output', fixture.output,
  ], { cwd: fixture.harnessRoot, encoding: 'utf8', env: { ...process.env, NODE_OPTIONS: '' } });
  return {
    process: result,
    record: readFileSync(fixture.output, 'utf8').length > 0 ? JSON.parse(readFileSync(fixture.output, 'utf8')) : null,
  };
}

function rewriteIdentity(fixture, mutate) {
  mutate(fixture.identity);
  writeFileSync(fixture.identityPath, `${JSON.stringify(fixture.identity, null, 2)}\n`);
  fixture.identitySha256 = digestFile(fixture.identityPath);
}

const expectedControls = new Map([
  ['P-ROLE-EXACT', ['phase1.exact-role-bindings', 'positive']],
  ['N-ROLE-MISMATCH', ['phase1.exact-role-bindings', 'negative']],
  ['P-PROCESS-EXACT', ['phase1.process-contract-oracle', 'positive']],
  ['N-PROCESS-MISMATCH', ['phase1.process-contract-oracle', 'negative']],
  ['P-IDENTITY-EXACT', ['phase1.fixed-identity-authentication', 'positive']],
  ['N-IDENTITY-DIGEST', ['phase1.fixed-identity-authentication', 'negative']],
  ['P-CLEAN-COMPLETION', ['phase1.deterministic-cleanup', 'positive']],
  ['N-CLEANUP-FAILURE', ['phase1.deterministic-cleanup', 'negative']],
  ['P-CALCULATOR-CORRECT', ['phase1.calculator-temperature-oracle', 'positive']],
  ['N-CALCULATOR-WRONG', ['phase1.calculator-temperature-oracle', 'negative']],
  ['P-TEMPERATURE-CORRECT', ['phase1.calculator-temperature-oracle', 'positive']],
  ['N-TEMPERATURE-WRONG', ['phase1.calculator-temperature-oracle', 'negative']],
]);

const expectedCapabilityControls = new Map([
  ['phase1.exact-role-bindings', [['P-ROLE-EXACT'], ['N-ROLE-MISMATCH']]],
  ['phase1.process-contract-oracle', [['P-PROCESS-EXACT'], ['N-PROCESS-MISMATCH']]],
  ['phase1.fixed-identity-authentication', [['P-IDENTITY-EXACT'], ['N-IDENTITY-DIGEST']]],
  ['phase1.deterministic-cleanup', [['P-CLEAN-COMPLETION'], ['N-CLEANUP-FAILURE']]],
  ['phase1.calculator-temperature-oracle', [
    ['P-CALCULATOR-CORRECT', 'P-TEMPERATURE-CORRECT'],
    ['N-CALCULATOR-WRONG', 'N-TEMPERATURE-WRONG'],
  ]],
]);

const expectedReasons = {
  'P-ROLE-EXACT': 'exact-role-bindings',
  'N-ROLE-MISMATCH': 'role-binding-mismatch',
  'P-PROCESS-EXACT': 'process-contract-match',
  'N-PROCESS-MISMATCH': 'process-contract-mismatch',
  'P-IDENTITY-EXACT': 'identity-authenticated',
  'N-IDENTITY-DIGEST': 'stale-identity-digest',
  'P-CLEAN-COMPLETION': 'workspace-cleaned',
  'N-CLEANUP-FAILURE': 'workspace-cleanup-failed',
  'P-CALCULATOR-CORRECT': 'oracle-match',
  'N-CALCULATOR-WRONG': 'oracle-mismatch',
  'P-TEMPERATURE-CORRECT': 'oracle-match',
  'N-TEMPERATURE-WRONG': 'oracle-mismatch',
};

function verifyResult(record, expected) {
  assert.equal(record.schema, 'mdlm-phase1-capability-controls@1');
  assert.equal(record.status, 'pass');
  assert.equal(record.evidenceIdentity, expected.identityId);
  assert.equal(record.identitySha256, expected.identitySha256);
  assert.deepEqual(record.source, expected.source);
  assert.equal(record.configurationSha256, digestFile(config));
  assert.equal(record.runtime.executable, process.execPath);
  assert.equal(record.runtime.executableSha256, digestFile(process.execPath));
  assert.equal(record.runtime.nodeVersion, process.versions.node);
  assert.equal(record.capabilities.length, 5);
  assert.equal(record.controls.length, 12);
  assert.equal(new Set(record.controls.map((entry) => entry.id)).size, 12);
  const capabilityById = new Map(record.capabilities.map((entry) => [entry.id, entry]));
  assert.equal(capabilityById.size, 5);
  for (const [id, [positiveControlIds, negativeControlIds]] of expectedCapabilityControls) {
    assert.deepEqual(capabilityById.get(id), { id, positiveControlIds, negativeControlIds });
  }
  for (const entry of record.controls) {
    const [capabilityId, polarity] = expectedControls.get(entry.id) ?? [];
    assert.ok(capabilityId, `unexpected control ${entry.id}`);
    assert.equal(entry.capabilityId, capabilityId);
    assert.equal(entry.polarity, polarity);
    assert.equal(entry.evidenceIdentity, expected.identityId);
    assert.equal(entry.identitySha256, expected.identitySha256);
    assert.equal(entry.pass, true);
    assert.equal(entry.outcome, 'pass');
    assert.ok(isObject(entry.stimulus));
    assert.ok(isObject(entry.observation));
    assert.deepEqual(entry.stimulus, independentStimulus(entry.id));
    assert.deepEqual(entry.expected, {
      decision: entry.polarity === 'positive' ? 'accepted' : 'rejected',
      reason: expectedReasons[entry.id],
    });
    assert.deepEqual(entry.observed, independentlyEvaluate(entry));
  }
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function usable(observation) {
  return observation.signal === null && !observation.timedOut && !observation.spawnError &&
    observation.cleanupComplete && observation.streams?.complete === true &&
    !observation.stdoutTruncated && !observation.stderrTruncated;
}

function processMatches(actual, expected) {
  return usable(actual) && actual.status === expected.status &&
    actual.stdoutBase64 === expected.stdoutBase64 && actual.stderrBase64 === expected.stderrBase64;
}

function independentStimulus(id) {
  const bindings = JSON.parse(readFileSync(config, 'utf8')).bindings;
  const values = {
    'P-ROLE-EXACT': { kind: 'exact-role-bindings', bindings },
    'N-ROLE-MISMATCH': { kind: 'one-field-role-mutation', field: 'runner', value: 'bin/one-field-role-mismatch.mjs' },
    'P-PROCESS-EXACT': { kind: 'exact-process-contract', argv: ['process-exact'] },
    'N-PROCESS-MISMATCH': { kind: 'wrong-status-and-stream', argv: ['process-wrong'] },
    'P-IDENTITY-EXACT': { kind: 'authenticate-exact-composed-identity' },
    'N-IDENTITY-DIGEST': { kind: 'one-field-digest-mutation', field: 'runner.executableSha256', value: `sha256:${'0'.repeat(64)}` },
    'P-CLEAN-COMPLETION': { kind: 'controlled-clean-completion', argv: ['clean'] },
    'N-CLEANUP-FAILURE': { kind: 'controlled-workspace-cleanup-failure', argv: ['block-workspace'] },
    'P-CALCULATOR-CORRECT': { kind: 'calculator-positive-oracle-control', argv: ['1', '+', '2'] },
    'N-CALCULATOR-WRONG': { kind: 'calculator-negative-oracle-control', argv: ['1', '+', '2'] },
    'P-TEMPERATURE-CORRECT': { kind: 'temperature-positive-oracle-control', argv: ['0', 'C', 'F'] },
    'N-TEMPERATURE-WRONG': { kind: 'temperature-negative-oracle-control', argv: ['0', 'C', 'F'] },
  };
  return values[id];
}

function independentlyEvaluate(entry) {
  const raw = entry.observation;
  if (entry.id === 'P-ROLE-EXACT' || entry.id === 'N-ROLE-MISMATCH') {
    const exactBindings = JSON.parse(readFileSync(config, 'utf8')).bindings;
    const evaluatedBindings = structuredClone(exactBindings);
    if (entry.id === 'N-ROLE-MISMATCH') evaluatedBindings.runner = 'bin/one-field-role-mismatch.mjs';
    assert.deepEqual(raw.manifestBindings, exactBindings);
    assert.deepEqual(raw.evaluatedBindings, evaluatedBindings);
    const accepted = isDeepStrictEqual(raw.manifestBindings, raw.evaluatedBindings);
    return { decision: accepted ? 'accepted' : 'rejected', reason: accepted ? 'exact-role-bindings' : 'role-binding-mismatch' };
  }
  if (entry.id === 'P-IDENTITY-EXACT') {
    const accepted = raw.errors.length === 0;
    return { decision: accepted ? 'accepted' : 'rejected', reason: accepted ? 'identity-authenticated' : 'identity-rejected' };
  }
  if (entry.id === 'N-IDENTITY-DIGEST') {
    const stale = raw.errors.some((error) => error.reason === 'stale-evidence-digest' && error.context === 'runner.executable');
    return { decision: stale ? 'rejected' : 'accepted', reason: stale ? 'stale-identity-digest' : 'unexpected-identity-result' };
  }
  if (entry.id === 'P-CLEAN-COMPLETION') {
    const accepted = raw.complete && raw.workspace.cleaned && raw.cleanup.complete;
    return { decision: accepted ? 'accepted' : 'rejected', reason: 'workspace-cleaned' };
  }
  if (entry.id === 'N-CLEANUP-FAILURE') {
    const rejected = !raw.controlledCase.complete && !raw.controlledCase.cleanup.complete &&
      raw.controlledCase.errors.some((error) => error.code === 'WORKSPACE_CLEANUP_FAILED') && raw.repair.complete;
    return { decision: rejected ? 'rejected' : 'accepted', reason: rejected ? 'workspace-cleanup-failed' : 'unexpected-cleanup-result' };
  }
  const fixedExpectations = {
    'P-PROCESS-EXACT': { status: 17, stdoutBase64: 'cHJvY2Vzcy1jb250cmFjdAo=', stderrBase64: '' },
    'N-PROCESS-MISMATCH': { status: 17, stdoutBase64: 'cHJvY2Vzcy1jb250cmFjdAo=', stderrBase64: '' },
    'P-CALCULATOR-CORRECT': { status: 0, stdoutBase64: 'Mwo=', stderrBase64: '' },
    'N-CALCULATOR-WRONG': { status: 0, stdoutBase64: 'Mwo=', stderrBase64: '' },
    'P-TEMPERATURE-CORRECT': { status: 0, stdoutBase64: 'MzIK', stderrBase64: '' },
    'N-TEMPERATURE-WRONG': { status: 0, stdoutBase64: 'MzIK', stderrBase64: '' },
  };
  const fixedExpected = fixedExpectations[entry.id];
  assert.deepEqual(raw.expected, fixedExpected);
  const matches = processMatches(raw.actual, fixedExpected);
  const actualUsable = usable(raw.actual);
  const accepted = entry.polarity === 'positive' ? matches : matches || !actualUsable;
  const processControl = entry.id.includes('PROCESS');
  const reason = actualUsable
    ? (matches ? (processControl ? 'process-contract-match' : 'oracle-match') : (processControl ? 'process-contract-mismatch' : 'oracle-mismatch'))
    : 'unusable-process-observation';
  return { decision: accepted ? 'accepted' : 'rejected', reason };
}

test('capability-controls emits 12 exact-composition controls for exactly five capabilities', () => {
  const fixture = makeFixture();
  try {
    const { process: child, record } = invoke(fixture);
    assert.equal(child.status, 0, child.stderr);
    assert.equal(record.schema, 'mdlm-phase1-capability-controls@1');
    assert.equal(record.status, 'pass');
    assert.equal(record.evidenceIdentity, fixture.identity.id);
    assert.equal(record.identitySha256, fixture.identitySha256);
    assert.deepEqual(record.capabilities.map(({ id }) => id).sort(), capabilities);
    assert.equal(record.controls.length, 12);
    assert.equal(new Set(record.controls.map(({ id }) => id)).size, 12);
    for (const control of record.controls) {
      assert.ok(capabilities.includes(control.capabilityId));
      assert.ok(['positive', 'negative'].includes(control.polarity));
      assert.equal(control.evidenceIdentity, fixture.identity.id);
      assert.equal(control.identitySha256, fixture.identitySha256);
      assert.equal(control.outcome, 'pass');
      assert.equal(typeof control.stimulus, 'object');
      assert.equal(typeof control.expected, 'object');
      assert.equal(typeof control.observed, 'object');
      assert.equal(typeof control.observation, 'object');
    }
    for (const capability of record.capabilities) {
      for (const id of [...capability.positiveControlIds, ...capability.negativeControlIds]) {
        assert.equal(record.controls.filter((entry) => entry.id === id && entry.capabilityId === capability.id).length, 1);
      }
    }
    verifyResult(record, {
      identityId: fixture.identity.id,
      identitySha256: fixture.identitySha256,
      source: {
        commit: git('rev-parse', 'HEAD^{commit}'),
        tree: git('rev-parse', 'HEAD^{tree}'),
        manifestSha256: digestFile(manifest),
        manifestGitBlob: gitBlob(manifest),
        clean: true,
      },
    });
  } finally {
    rmSync(fixture.temporary, { recursive: true, force: true });
  }
});

test('capability-controls rejects identity bytes that do not match the external trust input before controls', () => {
  const fixture = makeFixture();
  try {
    const staleDigest = fixture.identitySha256;
    rewriteIdentity(fixture, (identity) => { identity.id = 'changed-after-trust-input'; });
    const { process: child, record } = invoke(fixture, { identitySha256: staleDigest });
    assert.notEqual(child.status, 0);
    assert.equal(record.status, 'fail');
    assert.deepEqual(record.controls, []);
    assert.ok(record.errors.some((error) => error.reason === 'identity-digest-mismatch'));
  } finally {
    rmSync(fixture.temporary, { recursive: true, force: true });
  }
});

test('capability-controls emits a schema-valid fail envelope for a malformed identity trust input', () => {
  const fixture = makeFixture();
  try {
    const { process: child, record } = invoke(fixture, { identitySha256: 'not-a-sha256' });
    assert.notEqual(child.status, 0);
    assert.equal(record.schema, 'mdlm-phase1-capability-controls@1');
    assert.equal(record.status, 'fail');
    assert.equal(record.identitySha256, null);
    assert.deepEqual(record.controls, []);
    assert.deepEqual(record.errors, [{ reason: 'invalid-identity-trust-input' }]);
  } finally {
    rmSync(fixture.temporary, { recursive: true, force: true });
  }
});

test('capability-controls emits a schema-valid fail envelope for a non-string identity ID', () => {
  const fixture = makeFixture();
  try {
    rewriteIdentity(fixture, (identity) => { identity.id = { malformed: true }; });
    const { process: child, record } = invoke(fixture);
    assert.notEqual(child.status, 0);
    assert.equal(record.schema, 'mdlm-phase1-capability-controls@1');
    assert.equal(record.status, 'fail');
    assert.equal(record.evidenceIdentity, null);
    assert.deepEqual(record.controls, []);
    assert.ok(record.errors.some((error) => error.reason === 'missing-identity-field' && error.field === 'id'));
  } finally {
    rmSync(fixture.temporary, { recursive: true, force: true });
  }
});

for (const [name, field, mutate] of [
  ['harness commit', 'harnessCommit', (identity) => { identity.harness.commit = 'a'.repeat(40); }],
  ['harness tree', 'harnessTree', (identity) => { identity.harness.tree = 'b'.repeat(40); }],
  ['configuration digest', 'harnessConfigurationSha256', (identity) => { identity.harness.configurationSha256 = `sha256:${'c'.repeat(64)}`; }],
  ['runtime executable', 'runtimeExecutable', (identity) => {
    identity.runtime.executable = path.join(root, 'package.json');
    identity.runtime.executableSha256 = digestFile(identity.runtime.executable);
  }],
  ['runtime digest', null, (identity) => { identity.runtime.executableSha256 = `sha256:${'d'.repeat(64)}`; }],
  ['runtime version', 'runtimeNodeVersion', (identity) => { identity.runtime.nodeVersion = '24.0.0-mismatch'; }],
]) {
  test(`capability-controls rejects ${name} mismatch before controls`, () => {
    const fixture = makeFixture();
    try {
      rewriteIdentity(fixture, mutate);
      const { process: child, record } = invoke(fixture);
      assert.notEqual(child.status, 0);
      assert.equal(record.status, 'fail');
      assert.deepEqual(record.controls, []);
      if (field) assert.ok(record.errors.some((error) => error.reason === 'composition-binding-mismatch' && error.field === field));
      else assert.ok(record.errors.some((error) => error.reason === 'stale-evidence-digest'));
    } finally {
      rmSync(fixture.temporary, { recursive: true, force: true });
    }
  });
}

test('identity byte changes produce new control bindings when the changed identity remains valid', () => {
  const fixture = makeFixture();
  try {
    const originalDigest = fixture.identitySha256;
    rewriteIdentity(fixture, (identity) => { identity.id = 'capability-controls-second-valid-identity'; });
    const { process: child, record } = invoke(fixture);
    assert.equal(child.status, 0, child.stderr);
    assert.notEqual(record.identitySha256, originalDigest);
    assert.equal(record.identitySha256, fixture.identitySha256);
    assert.ok(record.controls.every((control) =>
      control.evidenceIdentity === fixture.identity.id && control.identitySha256 === fixture.identitySha256));
  } finally {
    rmSync(fixture.temporary, { recursive: true, force: true });
  }
});

for (const [name, mutate] of [
  ['missing control ID', (configuration) => configuration.capabilities[0].positiveControlIds.pop()],
  ['non-discriminating control composition', (configuration) => {
    configuration.capabilities[0].negativeControlIds[0] = configuration.capabilities[0].positiveControlIds[0];
  }],
]) {
  test(`capability-controls rejects ${name}`, () => {
    const fixture = makeFixture();
    try {
      const changedConfig = JSON.parse(readFileSync(config, 'utf8'));
      mutate(changedConfig);
      const changedConfigPath = path.join(fixture.temporary, 'capability-controls.json');
      writeFileSync(changedConfigPath, `${JSON.stringify(changedConfig, null, 2)}\n`);
      const { process: child, record } = invoke(fixture, { config: changedConfigPath });
      assert.notEqual(child.status, 0);
      assert.equal(record.status, 'fail');
      assert.deepEqual(record.controls, []);
      assert.ok(record.errors.some((error) => ['control-composition-mismatch', 'control-id-set-mismatch'].includes(error.reason)));
    } finally {
      rmSync(fixture.temporary, { recursive: true, force: true });
    }
  });
}

test('the independent result verifier rejects missing, extra, duplicate, self-declared, and mismatched controls', () => {
  const fixture = makeFixture();
  try {
    const { process: child, record } = invoke(fixture);
    assert.equal(child.status, 0, child.stderr);
    const expected = {
      identityId: fixture.identity.id,
      identitySha256: fixture.identitySha256,
      source: {
        commit: git('rev-parse', 'HEAD^{commit}'),
        tree: git('rev-parse', 'HEAD^{tree}'),
        manifestSha256: digestFile(manifest),
        manifestGitBlob: gitBlob(manifest),
        clean: true,
      },
    };
    const mutations = [
      (value) => value.controls.pop(),
      (value) => value.controls.push({ ...value.controls[0], id: 'EXTRA' }),
      (value) => value.controls.push(structuredClone(value.controls[0])),
      (value) => {
        value.capabilities[0].positiveControlIds = ['SELF-DECLARED'];
        value.controls[0].id = 'SELF-DECLARED';
      },
      (value) => { value.controls[0].capabilityId = 'phase1.process-contract-oracle'; },
      (value) => {
        value.controls[0].expected = { decision: 'fabricated', reason: 'fabricated' };
        value.controls[0].observed = { decision: 'fabricated', reason: 'fabricated' };
      },
      (value) => { value.controls[0].stimulus = { kind: 'fabricated' }; },
    ];
    for (const mutate of mutations) {
      const changed = structuredClone(record);
      mutate(changed);
      assert.throws(() => verifyResult(changed, expected));
    }
  } finally {
    rmSync(fixture.temporary, { recursive: true, force: true });
  }
});

for (const [name, relativeFile] of [
  ['source drift', 'README.md'],
  ['npm launcher drift', 'package.json'],
]) {
  test(`capability-controls rejects ${name} against the reported commit and tree`, () => {
    const cloneParent = mkdtempSync(path.join(tmpdir(), 'phase1-capability-source-drift-'));
    const cloneRoot = path.join(cloneParent, 'harness');
    execFileSync('/usr/bin/git', ['clone', '--quiet', '--no-local', root, cloneRoot]);
    const fixture = makeFixture(cloneRoot);
    const file = path.join(cloneRoot, relativeFile);
    const original = readFileSync(file);
    try {
      writeFileSync(file, Buffer.concat([original, Buffer.from('\nsource-drift\n')]));
      const { process: child, record } = invoke(fixture);
      assert.notEqual(child.status, 0);
      assert.equal(record.status, 'fail');
      assert.deepEqual(record.controls, []);
      assert.ok(record.errors.some((error) => error.reason === 'composition-binding-mismatch' ||
        (error.reason === 'capability-controls-failed' && error.detail.includes(relativeFile))));
    } finally {
      rmSync(fixture.temporary, { recursive: true, force: true });
      rmSync(cloneParent, { recursive: true, force: true });
    }
  });
}

test('capability-controls remains separate from the unchanged 16-case qualify gate', () => {
  const temporary = mkdtempSync(path.join(tmpdir(), 'phase1-qualify-unchanged-'));
  try {
    const output = path.join(temporary, 'qualification.json');
    const child = spawnSync(process.execPath, [
      command, 'qualify', '--config', path.join(root, 'config/qualification.json'), '--output', output,
    ], { cwd: root, encoding: 'utf8', env: { ...process.env, NODE_OPTIONS: '' } });
    assert.equal(child.status, 0, child.stderr);
    const record = JSON.parse(readFileSync(output, 'utf8'));
    assert.equal(record.kind, 'phase1-environment-qualification');
    assert.equal(record.pass, true);
    assert.equal(record.probes.length + record.cases.length + record.negativeControls.length, 16);
    assert.equal(JSON.stringify(record).includes('mdlm-phase1-capability-controls@1'), false);
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});
