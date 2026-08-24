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
