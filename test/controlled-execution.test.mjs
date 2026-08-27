import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, writeFileSync } from 'node:fs';
import { open } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test, { after } from 'node:test';
import { executeControlledCase } from '../lib/controlled-execution.mjs';

const root = path.resolve('.');
const packageMetadata = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
const targetBytes = readFileSync(path.join(root, 'test/fixtures/controlled-target.mjs'));
const fixtureBytes = Buffer.from([0x00, 0xff, 0x0a, 0x0d, 0x41]);
const targetRepository = mkdtempSync(path.join(tmpdir(), 'phase1-controlled-target-repository-'));
const git = (...args) => execFileSync('/usr/bin/git', args, { cwd: targetRepository, encoding: 'utf8' }).trim();
git('init', '-q');
git('config', 'user.name', 'Test');
git('config', 'user.email', 'test@example.invalid');
mkdirSync(path.join(targetRepository, 'target'));
writeFileSync(path.join(targetRepository, 'target/controlled-target.mjs'), targetBytes, { mode: 0o755 });
git('add', 'target/controlled-target.mjs');
git('commit', '-qm', 'controlled target');
const targetCommit = git('rev-parse', 'HEAD');
const targetTree = git('rev-parse', 'HEAD^{tree}');
const targetBlob = git('rev-parse', `${targetCommit}:target/controlled-target.mjs`);
after(() => rmSync(targetRepository, { recursive: true, force: true }));

function digest(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function encoded(bytes) {
  return { bytesBase64: bytes.toString('base64'), sha256: digest(bytes) };
}

function requestFor(temporary, overrides = {}) {
  return {
    schemaVersion: 1,
    capabilities: { required: ['controlled-execution@1', 'execution-profile@1'] },
    target: {
      repository: targetRepository,
      commit: targetCommit,
      tree: targetTree,
      entrypoint: {
        path: 'target/controlled-target.mjs',
        runtime: 'node',
        gitMode: '100755',
        gitBlob: targetBlob,
        sha256: digest(targetBytes),
      },
    },
    executionProfile: {
      schemaVersion: 1,
      id: 'controlled-case-test-profile',
      entrypoint: {
        runtime: 'node',
        path: 'target/controlled-target.mjs',
        mode: '0500',
        ...encoded(targetBytes),
      },
      environment: {
        LANG: 'C.UTF-8',
        LC_ALL: 'C.UTF-8',
        TZ: 'UTC',
        variables: {
          CASE_SENTINEL: 'declared',
          ...(overrides.launchMarker ? { LAUNCH_MARKER: path.join(temporary, 'launch-marker') } : {}),
        },
      },
      limits: {
        deadlineMs: 500,
        termGraceMs: 50,
        maxPathBytes: 120,
        maxFixtureBytes: 1024,
        maxAggregateFixtureBytes: 1200,
        maxStdinBytes: 2 * 1024 * 1024,
        maxOutputBytes: 1024 * 1024,
      },
    },
    case: {
      id: 'binary-case',
      argv: ['observe', 'data/input.bin'],
      stdin: encoded(Buffer.from([0x00, 0xfe, 0x41, 0x0a])),
      fixtures: [{ path: 'data/input.bin', mode: '0400', ...encoded(fixtureBytes) }],
    },
  };
}

function errorWithCode(result, code) {
  return result.errors.find((error) => error.code === code);
}

function assertWorkspaceCleaned(result) {
  assert.equal(result.workspace.cleaned, true);
  assert.equal(existsSync(result.workspace.path), false);
  assert.equal(result.cleanup.complete, true);
}

function assertDerivedIdentities(result) {
  assert.equal(result.identities.target.commit, targetCommit);
  assert.equal(result.identities.target.tree, targetTree);
  assert.equal(result.identities.target.entrypoint.gitBlob, targetBlob);
  assert.equal(result.identities.target.entrypoint.sha256, digest(targetBytes));
  assert.equal(result.identities.runner.id, 'mdlm-phase1-qualification-harness');
  assert.match(result.identities.runner.manifestSha256, /^[0-9a-f]{64}$/);
  assert.deepEqual(result.identities.adapter, { id: 'run-exact@2' });
  assert.equal(result.identities.profile.id, 'controlled-case-test-profile');
  assert.match(result.identities.profile.sha256, /^[0-9a-f]{64}$/);
}

test('public npm test selects only intended top-level tests', () => {
  assert.equal(
    packageMetadata.scripts.test,
    'NODE_OPTIONS= "$npm_node_execpath" --test --test-concurrency=1 test/*.test.mjs',
  );
  assert.equal(digest(targetBytes), '92d3c90e91720e0a8ec57bc2395ff96674744a799922f4f26bdae10bf86f4853');
});

async function rejectedFixture(mutator, code) {
  const temporary = mkdtempSync(path.join(tmpdir(), 'phase1-controlled-rejected-'));
  try {
    const request = requestFor(temporary, { launchMarker: true });
    mutator(request);
    const result = await executeControlledCase(request);
    assert.equal(result.complete, false);
    assert.equal(result.execution.started, false);
    assert.ok(errorWithCode(result, code), JSON.stringify(result.errors));
    assert.equal(existsSync(path.join(temporary, 'launch-marker')), false);
    if (result.workspace.created) assertWorkspaceCleaned(result);
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}

test('executeControlledCase preserves binary stdin and fixtures with exact identities and metadata', async () => {
  const temporary = mkdtempSync(path.join(tmpdir(), 'phase1-controlled-binary-'));
  try {
    const request = requestFor(temporary);
    const result = await executeControlledCase(request);
    assert.equal(result.schemaVersion, 1);
    assert.equal(result.kind, 'controlled-case-result');
    assert.deepEqual(result.capabilities, {
      implemented: ['controlled-execution@1', 'execution-profile@1'],
      required: request.capabilities.required,
    });
    assertDerivedIdentities(result);
    assert.equal(result.complete, true);
    assert.equal(result.truncated, false);
    assert.deepEqual(result.environment.attested, {
      LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8', TZ: 'UTC', variables: { CASE_SENTINEL: 'declared' },
    });
    assert.deepEqual(result.setup.fixtures, [{
      path: 'data/input.bin', mode: '0400', size: fixtureBytes.length, sha256: digest(fixtureBytes),
    }]);
    assert.deepEqual(result.post.fixtures, result.setup.fixtures);
    assert.deepEqual(result.execution.stdin, {
      supplied: true,
      expectedBytes: 4,
      writtenBytes: 4,
      sha256: digest(Buffer.from([0x00, 0xfe, 0x41, 0x0a])),
      eof: 'closed',
      complete: true,
      error: null,
    });
    const observation = JSON.parse(Buffer.from(result.execution.observation.stdoutBase64, 'base64').toString('utf8'));
    assert.equal(observation.stdinBase64, 'AP5BCg==');
    assert.equal(observation.fixtureBase64, fixtureBytes.toString('base64'));
    assert.deepEqual(observation.environment, {
      LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8', TZ: 'UTC', CASE_SENTINEL: 'declared',
      AMBIENT_SECRET: null, NODE_OPTIONS: null,
    });
    assertWorkspaceCleaned(result);
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});

test('executeControlledCase does not inherit ambient environment variables', async () => {
  const temporary = mkdtempSync(path.join(tmpdir(), 'phase1-controlled-environment-'));
  const previous = process.env.AMBIENT_SECRET;
  process.env.AMBIENT_SECRET = 'must-not-leak';
  try {
    const result = await executeControlledCase(requestFor(temporary));
    const observation = JSON.parse(Buffer.from(result.execution.observation.stdoutBase64, 'base64').toString('utf8'));
    assert.equal(observation.environment.AMBIENT_SECRET, null);
    assert.equal(result.environment.inherited, false);
    assertWorkspaceCleaned(result);
  } finally {
    if (previous === undefined) delete process.env.AMBIENT_SECRET;
    else process.env.AMBIENT_SECRET = previous;
    rmSync(temporary, { recursive: true, force: true });
  }
});

test('executeControlledCase rejects ambient NODE_OPTIONS before workspace creation', async () => {
  const temporary = mkdtempSync(path.join(tmpdir(), 'phase1-controlled-node-options-'));
  const previous = process.env.NODE_OPTIONS;
  process.env.NODE_OPTIONS = '--require=/tmp/untrusted.cjs';
  try {
    const result = await executeControlledCase(requestFor(temporary, { launchMarker: true }));
    assert.equal(result.complete, false);
    assert.equal(result.workspace.created, false);
    assert.equal(result.execution.started, false);
    assert.ok(errorWithCode(result, 'UNTRUSTED_AMBIENT_NODE_OPTIONS'));
    assert.equal(existsSync(path.join(temporary, 'launch-marker')), false);
  } finally {
    if (previous === undefined) delete process.env.NODE_OPTIONS;
    else process.env.NODE_OPTIONS = previous;
    rmSync(temporary, { recursive: true, force: true });
  }
});

test('executeControlledCase rejects requested NODE_OPTIONS before target launch', async () => {
  await rejectedFixture((request) => {
    request.executionProfile.environment.variables.NODE_OPTIONS = '--inspect';
  }, 'UNSUPPORTED_ENVIRONMENT_VARIABLE');
});

for (const [name, mutate, code] of [
  ['traversal', (request) => { request.case.fixtures[0].path = '../outside'; }, 'UNSAFE_FIXTURE_PATH'],
  ['absolute path', (request) => { request.case.fixtures[0].path = '/tmp/outside'; }, 'UNSAFE_FIXTURE_PATH'],
  ['noncanonical path', (request) => { request.case.fixtures[0].path = 'data/./input.bin'; }, 'UNSAFE_FIXTURE_PATH'],
  ['oversized path', (request) => { request.case.fixtures[0].path = `${'a'.repeat(121)}`; }, 'FIXTURE_PATH_TOO_LONG'],
  ['symlink declaration', (request) => {
    request.case.fixtures[0] = { path: 'data/link', kind: 'symlink', target: '../outside' };
  }, 'UNSUPPORTED_FIXTURE_TYPE'],
  ['unsupported mode', (request) => { request.case.fixtures[0].mode = '0777'; }, 'UNSUPPORTED_FIXTURE_MODE'],
  ['noncanonical mode', (request) => { request.case.fixtures[0].mode = '400'; }, 'UNSUPPORTED_FIXTURE_MODE'],
  ['oversized file', (request) => {
    Object.assign(request.case.fixtures[0], encoded(Buffer.alloc(1025)));
  }, 'FIXTURE_TOO_LARGE'],
  ['oversized aggregate', (request) => {
    request.case.fixtures = [
      { path: 'data/a', mode: '0400', ...encoded(Buffer.alloc(700)) },
      { path: 'data/b', mode: '0400', ...encoded(Buffer.alloc(700)) },
    ];
  }, 'FIXTURE_AGGREGATE_TOO_LARGE'],
  ['duplicate path', (request) => {
    request.case.fixtures.push({ ...request.case.fixtures[0] });
  }, 'DUPLICATE_FIXTURE_PATH'],
  ['noncanonical base64', (request) => { request.case.fixtures[0].bytesBase64 = 'AA'; }, 'NONCANONICAL_FIXTURE_BASE64'],
  ['malformed base64', (request) => { request.case.fixtures[0].bytesBase64 = '*not-base64*'; }, 'NONCANONICAL_FIXTURE_BASE64'],
  ['digest mismatch', (request) => { request.case.fixtures[0].sha256 = '0'.repeat(64); }, 'FIXTURE_DIGEST_MISMATCH'],
]) {
  test(`executeControlledCase rejects ${name} before target launch`, async () => {
    await rejectedFixture(mutate, code);
  });
}

for (const capability of [
  'filesystem-trace@1',
  'filesystem-fault-injection@1',
  'returned-byte-observation@1',
  'network-denial@1',
  'network-attempt-observation@1',
  'external-file-access-observation@1',
]) {
  test(`executeControlledCase rejects unsupported capability ${capability} before materialization`, async () => {
    const temporary = mkdtempSync(path.join(tmpdir(), 'phase1-controlled-capability-'));
    try {
      const request = requestFor(temporary, { launchMarker: true });
      request.capabilities.required.push(capability);
      const result = await executeControlledCase(request);
      assert.equal(result.complete, false);
      assert.equal(result.workspace.created, false);
      assert.equal(result.execution.started, false);
      assert.deepEqual(errorWithCode(result, 'UNSUPPORTED_CAPABILITY').details, { capability });
      assert.equal(existsSync(path.join(temporary, 'launch-marker')), false);
    } finally {
      rmSync(temporary, { recursive: true, force: true });
    }
  });
}

for (const [name, mode, expected] of [
  ['success', 'observe', { complete: true, status: 0, error: null }],
  ['nonzero target exit', 'nonzero', { complete: true, status: 7, error: null }],
  ['post-observation fixture mutation', 'mutate-fixture', { complete: false, status: 0, error: 'FIXTURE_CHANGED' }],
  ['timeout with stubborn descendant', 'hang-with-descendant', { complete: false, status: null, error: 'PROCESS_TIMEOUT' }],
  ['stdin failure after early exit', 'early-exit', { complete: false, status: 0, error: 'STDIN_WRITE_INCOMPLETE' }],
]) {
  test(`executeControlledCase retains typed evidence and cleans its workspace after ${name}`, async () => {
    const temporary = mkdtempSync(path.join(tmpdir(), 'phase1-controlled-cleanup-'));
    try {
      const request = requestFor(temporary);
      request.case.argv[0] = mode;
      if (mode === 'early-exit') request.case.stdin = encoded(Buffer.alloc(2 * 1024 * 1024, 0xa5));
      if (mode === 'hang-with-descendant') request.executionProfile.limits.deadlineMs = 100;
      const result = await executeControlledCase(request);
      assert.equal(result.complete, expected.complete);
      assert.equal(result.execution.observation.status, expected.status);
      assert.equal(result.execution.observation.cleanupComplete, true);
      if (expected.error) assert.ok(errorWithCode(result, expected.error), JSON.stringify(result.errors));
      else assert.deepEqual(result.errors, []);
      assertWorkspaceCleaned(result);
    } finally {
      rmSync(temporary, { recursive: true, force: true });
    }
  });
}

for (const [name, mode] of [
  ['fixture leaf replacement with an outside symlink', 'replace-fixture-leaf', 'file'],
  ['fixture parent replacement with an outside symlink', 'replace-fixture-parent', 'directory'],
  ['TOCTOU-style fixture inode replacement with an outside hard link', 'replace-fixture-hardlink', 'file'],
]) {
  test(`executeControlledCase rejects ${name} without reading outside bytes`, async () => {
    const temporary = mkdtempSync(path.join(tmpdir(), 'phase1-controlled-outside-'));
    try {
      const outsideDirectory = path.join(temporary, 'outside');
      const outsideTarget = path.join(outsideDirectory, 'input.bin');
      mkdirSync(outsideDirectory);
      const outsideBytes = Buffer.from(`outside-${mode}`);
      writeFileSync(outsideTarget, outsideBytes);
      const request = requestFor(temporary);
      request.case.argv[0] = mode;
      request.executionProfile.environment.variables.OUTSIDE_TARGET = outsideTarget;
      request.executionProfile.environment.variables.OUTSIDE_DIRECTORY = outsideDirectory;
      const result = await executeControlledCase(request);
      assert.equal(result.complete, false);
      assert.ok(errorWithCode(result, 'POST_OBSERVATION_FAILED'), JSON.stringify(result.errors));
      assert.equal(result.post.complete, false);
      assert.equal(JSON.stringify(result.post).includes(digest(outsideBytes)), false);
      assertWorkspaceCleaned(result);
    } finally {
      rmSync(temporary, { recursive: true, force: true });
    }
  });
}

test('executeControlledCase bounds post-execution fixture growth without an unbounded read', async () => {
  const temporary = mkdtempSync(path.join(tmpdir(), 'phase1-controlled-growth-'));
  try {
    const request = requestFor(temporary);
    request.case.argv[0] = 'grow-fixture';
    const result = await executeControlledCase(request);
    assert.equal(result.complete, false);
    assert.ok(errorWithCode(result, 'POST_OBSERVATION_FAILED'), JSON.stringify(result.errors));
    assert.equal(result.post.complete, false);
    assertWorkspaceCleaned(result);
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});

for (const [identity, mutate] of [
  ['runner', (request) => { request.identities = { runner: { commit: 'f'.repeat(40) } }; }],
  ['target', (request) => { request.target.entrypoint.gitBlob = 'e'.repeat(40); }],
  ['profile', (request) => { request.identities = { profile: { sha256: 'd'.repeat(64) } }; }],
]) {
  test(`executeControlledCase rejects a spoofed ${identity} identity before execution`, async () => {
    const temporary = mkdtempSync(path.join(tmpdir(), 'phase1-controlled-spoof-'));
    try {
      const request = requestFor(temporary, { launchMarker: true });
      mutate(request);
      const result = await executeControlledCase(request);
      assert.equal(result.complete, false);
      assert.equal(result.execution.started, false);
      assert.ok(errorWithCode(result, 'UNAUTHENTICATED_IDENTITY'), JSON.stringify(result.errors));
      assert.equal(existsSync(path.join(temporary, 'launch-marker')), false);
    } finally {
      rmSync(temporary, { recursive: true, force: true });
    }
  });
}

test('executeControlledCase closes a descriptor when setup observation and descriptor cleanup both fail', async () => {
  const temporary = mkdtempSync(path.join(tmpdir(), 'phase1-controlled-setup-observation-'));
  const probe = await open(path.join(root, 'package.json'), 'r');
  const fileHandlePrototype = Object.getPrototypeOf(probe);
  const originalStat = fileHandlePrototype.stat;
  const controlledHandles = new Map();
  await probe.close();

  fileHandlePrototype.stat = async function injectedSetupObservationFailure(...args) {
    let descriptorPath;
    try {
      descriptorPath = readlinkSync(`/proc/self/fd/${this.fd}`);
    } catch {
      return originalStat.apply(this, args);
    }
    if (!descriptorPath.includes('/mdlm-controlled-case-')) return originalStat.apply(this, args);

    if (!controlledHandles.has(this)) {
      const originalClose = this.close;
      const record = { descriptorPath, closeCalls: 0, originalClose };
      controlledHandles.set(this, record);
      this.close = async (...closeArgs) => {
        record.closeCalls += 1;
        await originalClose.apply(this, closeArgs);
        if (descriptorPath.endsWith('/data/input.bin')) {
          const error = new Error('injected descriptor close failure');
          error.code = 'EIO';
          throw error;
        }
      };
    }
    if (descriptorPath.endsWith('/data/input.bin')) {
      const error = new Error('injected setup observation failure');
      error.code = 'EIO';
      throw error;
    }
    return originalStat.apply(this, args);
  };

  try {
    const result = await executeControlledCase(requestFor(temporary));
    const records = [...controlledHandles.values()];
    const entrypoint = records.find((record) => record.descriptorPath.endsWith('/target/controlled-target.mjs'));
    const fixture = records.find((record) => record.descriptorPath.endsWith('/data/input.bin'));

    assert.equal(result.complete, false);
    assert.equal(result.setup.complete, false);
    assert.equal(result.execution.started, false);
    assert.equal(entrypoint?.closeCalls, 1);
    assert.equal(fixture?.closeCalls, 1);
    assert.equal(result.errors[0].code, 'CONTROLLED_CASE_FAILED');
    assert.equal(result.errors[0].message, 'injected setup observation failure');
    assert.equal(result.errors[1].code, 'DESCRIPTOR_CLEANUP_FAILED');
    assert.equal(result.errors[1].details.message, 'injected descriptor close failure');
    assertWorkspaceCleaned(result);
  } finally {
    fileHandlePrototype.stat = originalStat;
    for (const [handle, record] of controlledHandles) {
      if (record.closeCalls === 0) await record.originalClose.call(handle);
    }
    rmSync(temporary, { recursive: true, force: true });
  }
});

test('executeControlledCase reports POST_OBSERVATION_FAILED when a retained fixture disappears', async () => {
  const temporary = mkdtempSync(path.join(tmpdir(), 'phase1-controlled-post-failure-'));
  try {
    const request = requestFor(temporary);
    request.case.argv[0] = 'delete-fixture';
    const result = await executeControlledCase(request);
    assert.equal(result.complete, false);
    assert.ok(errorWithCode(result, 'POST_OBSERVATION_FAILED'), JSON.stringify(result.errors));
    assertWorkspaceCleaned(result);
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});

test('executeControlledCase reports OBSERVATION_TRUNCATED and fails closed', async () => {
  const temporary = mkdtempSync(path.join(tmpdir(), 'phase1-controlled-truncation-'));
  try {
    const request = requestFor(temporary);
    request.case.argv[0] = 'truncate-output';
    request.executionProfile.limits.maxOutputBytes = 64;
    const result = await executeControlledCase(request);
    assert.equal(result.complete, false);
    assert.equal(result.truncated, true);
    assert.ok(errorWithCode(result, 'OBSERVATION_TRUNCATED'), JSON.stringify(result.errors));
    assertWorkspaceCleaned(result);
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});

test('executeControlledCase reports PROCESS_CLEANUP_FAILED when cleanup exceeds its evidence bound', async () => {
  const temporary = mkdtempSync(path.join(tmpdir(), 'phase1-controlled-process-cleanup-'));
  try {
    const request = requestFor(temporary);
    request.case.argv[0] = 'hang-with-descendant';
    request.executionProfile.limits.deadlineMs = 50;
    request.executionProfile.limits.maxCleanupWaitMs = 0;
    const result = await executeControlledCase(request);
    assert.equal(result.complete, false);
    assert.ok(errorWithCode(result, 'PROCESS_CLEANUP_FAILED'), JSON.stringify(result.errors));
    assertWorkspaceCleaned(result);
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});

test('controlled-case CLI writes the complete typed result', () => {
  const temporary = mkdtempSync(path.join(tmpdir(), 'phase1-controlled-cli-'));
  try {
    const requestPath = path.join(temporary, 'request.json');
    const outputPath = path.join(temporary, 'result.json');
    writeFileSync(requestPath, JSON.stringify(requestFor(temporary)));
    const environment = { ...process.env };
    delete environment.NODE_OPTIONS;
    const command = spawnSync(process.execPath, [
      path.join(root, 'bin/mdlm-phase1-qualify.mjs'),
      'controlled-case', '--request', requestPath, '--output', outputPath,
    ], { cwd: root, env: environment, encoding: 'utf8' });
    assert.equal(command.status, 0, command.stderr);
    assert.deepEqual(JSON.parse(command.stdout), { ok: true, output: outputPath });
    const result = JSON.parse(readFileSync(outputPath, 'utf8'));
    assert.equal(result.kind, 'controlled-case-result');
    assert.equal(result.complete, true);
    assertDerivedIdentities(result);
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});

test('executeControlledCase reports cleanup failure as typed incomplete evidence', async () => {
  const temporary = mkdtempSync(path.join(tmpdir(), 'phase1-controlled-cleanup-failure-'));
  let workspacePath;
  try {
    const request = requestFor(temporary);
    request.case.argv[0] = 'block-workspace';
    const result = await executeControlledCase(request);
    workspacePath = result.workspace.path;
    assert.equal(result.complete, false);
    assert.equal(result.cleanup.complete, false);
    assert.ok(errorWithCode(result, 'WORKSPACE_CLEANUP_FAILED'));
    assert.equal(result.workspace.cleaned, false);
  } finally {
    if (workspacePath && existsSync(workspacePath)) {
      chmodSync(workspacePath, 0o700);
      rmSync(workspacePath, { recursive: true, force: true });
    }
    rmSync(temporary, { recursive: true, force: true });
  }
});
