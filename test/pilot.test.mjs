import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

const root = path.resolve('.');
const cli = path.join(root, 'bin/mdlm-phase1-qualify.mjs');
const targets = [
  ['calculator', 'https://github.com/taylorrowser/mdlm-calculator-pilot.git', '709497b329505a3c2a6f9d62abe2528099e14aaf'],
  ['temperature', 'https://github.com/taylorrowser/mdlm-temperature-pilot.git', 'd4112f81394dc1f65812fee0b2d88ba73ee443ea'],
];

function runInvalidProfile(entrypoint) {
  const temporary = mkdtempSync(path.join(tmpdir(), 'phase1-pilot-invalid-profile-'));
  try {
    const profilePath = path.join(temporary, 'profile.json');
    const output = path.join(temporary, 'evidence.json');
    writeFileSync(profilePath, JSON.stringify({
      schemaVersion: 1,
      id: 'invalid-entrypoint',
      repository: 'unused',
      commit: '0'.repeat(40),
      tree: '0'.repeat(40),
      entrypoint: {
        ...entrypoint,
        gitBlob: '0'.repeat(40),
        sha256: '0'.repeat(64),
      },
      deadlineMs: 1_000,
      cases: [{ id: 'normal', argv: [], expected: { status: 0, stdoutBase64: '', stderrBase64: '' } }],
    }));
    return spawnSync(process.execPath, [cli, 'pilot', '--profile', profilePath, '--repository', 'unused', '--commit', '0'.repeat(40), '--output', output], { encoding: 'utf8' });
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}

function createLocalTarget(name, entrypoint, mode) {
  const repository = mkdtempSync(path.join(tmpdir(), `phase1-pilot-${name}-repository-`));
  const git = (...args) => execFileSync('/usr/bin/git', args, { cwd: repository, encoding: 'utf8' }).trim();
  git('init', '-q');
  git('config', 'user.name', 'Test');
  git('config', 'user.email', 'test@example.invalid');
  writeFileSync(path.join(repository, 'public-command'), entrypoint, { mode });
  git('add', 'public-command');
  git('commit', '-qm', `${name} target`);
  const commit = git('rev-parse', 'HEAD');
  return {
    repository,
    commit,
    tree: git('rev-parse', 'HEAD^{tree}'),
    gitBlob: git('rev-parse', `${commit}:public-command`),
    sha256: createHash('sha256').update(entrypoint).digest('hex'),
  };
}

function runLocalPilot(target, { id, argv, expected, controlled = false }) {
  const temporary = mkdtempSync(path.join(tmpdir(), `phase1-pilot-${id}-`));
  try {
    const profilePath = path.join(temporary, 'profile.json');
    const output = path.join(temporary, 'evidence.json');
    writeFileSync(profilePath, JSON.stringify({
      schemaVersion: 1,
      id,
      repository: target.repository,
      commit: target.commit,
      tree: target.tree,
      entrypoint: {
        runtime: 'executable', path: 'public-command', gitBlob: target.gitBlob, sha256: target.sha256,
      },
      deadlineMs: 1_000,
      ...(controlled ? {
        capabilities: { required: ['controlled-execution@1', 'execution-profile@1'] },
        executionProfile: {
          schemaVersion: 1,
          id: `${id}-controlled-profile`,
          environment: { LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8', TZ: 'UTC', variables: {} },
          limits: {
            deadlineMs: 1_000,
            termGraceMs: 50,
            maxPathBytes: 120,
            maxFixtureBytes: 1024,
            maxAggregateFixtureBytes: 2048,
            maxStdinBytes: 1024,
            maxOutputBytes: 1024,
          },
        },
      } : {}),
      cases: [{ id: 'normal', argv, expected }],
    }));
    const result = spawnSync(process.execPath, [cli, 'pilot', '--profile', profilePath, '--repository', target.repository, '--commit', target.commit, '--output', output], { encoding: 'utf8' });
    return { result, evidence: result.status === 0 ? JSON.parse(readFileSync(output, 'utf8')) : null };
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}

for (const [name, repository, commit] of targets) {
  test(`pilot exact-checks the public ${name} commit through its declared entrypoint`, { timeout: 20_000 }, () => {
    const temporary = mkdtempSync(path.join(tmpdir(), `phase1-pilot-${name}-`));
    try {
      const output = path.join(temporary, 'evidence.json');
      const markerLog = path.join(temporary, 'node-options.log');
      const marker = path.join(temporary, 'marker.cjs');
      writeFileSync(marker, `require('node:fs').appendFileSync(${JSON.stringify(markerLog)}, String(process.pid) + '\\n');\n`);
      const result = spawnSync(process.execPath, [cli, 'pilot', '--profile', path.join(root, `profiles/${name}.json`), '--repository', repository, '--commit', commit, '--output', output], {
        encoding: 'utf8', timeout: 15_000, env: { ...process.env, NODE_OPTIONS: `--require=${marker}` },
      });
      assert.equal(result.status, 0, result.stderr);
      assert.equal(readFileSync(markerLog, 'utf8').trim().split('\n').length, 1, `NODE_OPTIONS preload reached a ${name} pilot child`);
      const evidence = JSON.parse(readFileSync(output, 'utf8'));
      assert.equal(evidence.pass, true);
      assert.equal(evidence.commit, commit);
      assert.match(evidence.runtime.executable, /^\//);
      assert.equal(evidence.runtime.executable, process.execPath);
      assert.equal(evidence.runtime.mode, 'node');
      assert.match(evidence.entrypoint.gitBlob, /^[a-f0-9]{40}$/);
      assert.match(evidence.entrypoint.sha256, /^[a-f0-9]{64}$/);
      assert.equal(evidence.cases.every(({ observation }) => observation.executable === process.execPath), true);
      assert.equal(evidence.cases.length, 4);
      assert.equal(evidence.cases.every(({ pass }) => pass), true);
    } finally {
      rmSync(temporary, { recursive: true, force: true });
    }
  });
}

test('pilot rejects an unsupported entrypoint runtime', () => {
  const result = runInvalidProfile({ runtime: 'python', path: 'cli.py' });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /supported runtime/);
});

test('pilot rejects an entrypoint path that escapes the materialization root', () => {
  const result = runInvalidProfile({ runtime: 'node', path: '../cli.mjs' });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /escapes the environment/);
});

test('pilot executes an authenticated non-Node executable entrypoint', () => {
  const target = createLocalTarget('executable', Buffer.from('#!/bin/sh\nprintf \'%s\\n\' "$1"\nprintf \'separate-stderr\\n\' >&2\nexit 7\n'), 0o755);
  try {
    const { result, evidence } = runLocalPilot(target, {
      id: 'non-node-executable',
      argv: ['not-node'],
      expected: { status: 7, stdoutBase64: 'bm90LW5vZGUK', stderrBase64: 'c2VwYXJhdGUtc3RkZXJyCg==' },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(evidence.pass, true);
    assert.equal(evidence.runtime.mode, 'executable');
    assert.equal(evidence.entrypoint.gitMode, '100755');
    assert.equal(evidence.cases[0].observation.executable.endsWith('/public-command'), true);
    assert.equal(evidence.cases[0].observation.status, 7);
    assert.equal(evidence.cases[0].observation.stdoutBase64, 'bm90LW5vZGUK');
    assert.equal(evidence.cases[0].observation.stderrBase64, 'c2VwYXJhdGUtc3RkZXJyCg==');
  } finally {
    rmSync(target.repository, { recursive: true, force: true });
  }
});

test('pilot consumes an explicit controlled execution profile through capability IDs', () => {
  const target = createLocalTarget('controlled', Buffer.from("#!/bin/sh\nprintf 'controlled\\n'\n"), 0o755);
  try {
    const { result, evidence } = runLocalPilot(target, {
      id: 'controlled-executable',
      argv: [],
      expected: { status: 0, stdoutBase64: 'Y29udHJvbGxlZAo=', stderrBase64: '' },
      controlled: true,
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(evidence.pass, true);
    assert.deepEqual(evidence.capabilities.required, ['controlled-execution@1', 'execution-profile@1']);
    assert.equal(evidence.cases[0].controlled.kind, 'controlled-case-result');
    assert.equal(evidence.cases[0].controlled.complete, true);
    assert.equal(evidence.cases[0].controlled.workspace.cleaned, true);
  } finally {
    rmSync(target.repository, { recursive: true, force: true });
  }
});

test('pilot routes the committed controlled candidate profile through executeControlledCase', { timeout: 20_000 }, () => {
  const temporary = mkdtempSync(path.join(tmpdir(), 'phase1-pilot-committed-controlled-'));
  try {
    const output = path.join(temporary, 'evidence.json');
    const profile = JSON.parse(readFileSync(path.join(root, 'profiles/controlled-calculator-candidate.json'), 'utf8'));
    const result = spawnSync(process.execPath, [
      cli, 'pilot',
      '--profile', path.join(root, 'profiles/controlled-calculator-candidate.json'),
      '--repository', profile.repository,
      '--commit', profile.commit,
      '--output', output,
    ], { encoding: 'utf8', timeout: 15_000 });
    assert.equal(result.status, 0, result.stderr);
    const evidence = JSON.parse(readFileSync(output, 'utf8'));
    assert.equal(evidence.pass, true);
    assert.equal(evidence.qualificationStatus, 'candidate-not-qualified');
    assert.equal(evidence.cases.length, 4);
    assert.equal(evidence.cases.every((entry) => entry.controlled.complete), true);
    assert.equal(evidence.cases.every((entry) => entry.controlled.identities.profile.id === 'controlled-execution-candidate-v1'), true);
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});

test('pilot rejects executable mode when Git does not authenticate the executable bit', () => {
  const target = createLocalTarget('permission', Buffer.from('#!/bin/sh\nprintf \'not-executable\\n\'\n'), 0o644);
  try {
    const { result } = runLocalPilot(target, {
      id: 'non-executable',
      argv: [],
      expected: { status: 0, stdoutBase64: 'bm90LWV4ZWN1dGFibGUK', stderrBase64: '' },
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /executable bit authenticated by Git/);
  } finally {
    rmSync(target.repository, { recursive: true, force: true });
  }
});

test('pilot rejects an executable that mutates its authenticated entrypoint', () => {
  const entrypoint = Buffer.from("#!/bin/sh\nrm \"$0\"\nprintf '#!/bin/sh\\nprintf hacked\\n' > \"$0\"\nchmod +x \"$0\"\nprintf 'original\\n'\n");
  const target = createLocalTarget('mutating', entrypoint, 0o755);
  try {
    const { result } = runLocalPilot(target, {
      id: 'mutating-executable',
      argv: [],
      expected: { status: 0, stdoutBase64: 'b3JpZ2luYWwK', stderrBase64: '' },
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /materialized public entrypoint changed/);
  } finally {
    rmSync(target.repository, { recursive: true, force: true });
  }
});

test('pilot rejects unsafe tree entries instead of checking out the target', () => {
  const repository = mkdtempSync(path.join(tmpdir(), 'phase1-pilot-unsafe-repository-'));
  const temporary = mkdtempSync(path.join(tmpdir(), 'phase1-pilot-unsafe-'));
  try {
    const git = (...args) => execFileSync('/usr/bin/git', args, { cwd: repository, encoding: 'utf8' }).trim();
    git('init', '-q');
    git('config', 'user.name', 'Test');
    git('config', 'user.email', 'test@example.invalid');
    const entrypoint = Buffer.from("process.stdout.write('ok\\n');\n");
    writeFileSync(path.join(repository, 'cli.mjs'), entrypoint);
    chmodSync(path.join(repository, 'cli.mjs'), 0o755);
    symlinkSync('cli.mjs', path.join(repository, 'unsafe-link'));
    git('add', '.');
    git('commit', '-qm', 'unsafe target');
    const commit = git('rev-parse', 'HEAD');
    const profile = {
      schemaVersion: 1,
      id: 'unsafe',
      repository,
      commit,
      tree: git('rev-parse', 'HEAD^{tree}'),
      entrypoint: {
        runtime: 'node', path: 'cli.mjs', gitBlob: git('rev-parse', `${commit}:cli.mjs`),
        sha256: createHash('sha256').update(entrypoint).digest('hex'),
      },
      deadlineMs: 1_000,
      cases: [{ id: 'normal', argv: [], expected: { status: 0, stdoutBase64: 'b2sK', stderrBase64: '' } }],
    };
    const profilePath = path.join(temporary, 'profile.json');
    const output = path.join(temporary, 'evidence.json');
    writeFileSync(profilePath, JSON.stringify(profile));
    const result = spawnSync(process.execPath, [cli, 'pilot', '--profile', profilePath, '--repository', repository, '--commit', commit, '--output', output], { encoding: 'utf8' });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /symlink/);
  } finally {
    rmSync(repository, { recursive: true, force: true });
    rmSync(temporary, { recursive: true, force: true });
  }
});
