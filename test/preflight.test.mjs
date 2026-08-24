import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

const cli = path.resolve('bin/mdlm-phase1-qualify.mjs');

function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

test('preflight rejects a lifecycle-only environment before publication', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'phase1-preflight-red-'));
  try {
    git(root, 'init', '-q');
    git(root, 'config', 'user.name', 'Test');
    git(root, 'config', 'user.email', 'test@example.invalid');
    mkdirSync(path.join(root, '.lifecycle'), { recursive: true });
    writeFileSync(path.join(root, '.lifecycle', 'state.json'), '{}\n');
    git(root, 'add', '.');
    git(root, 'commit', '-qm', 'lifecycle only');
    const commit = git(root, 'rev-parse', 'HEAD');
    const tree = git(root, 'rev-parse', 'HEAD^{tree}');
    const bindings = {
      runner: 'bin/mdlm-phase1-qualify.mjs',
      configuration: 'config/qualification.json',
      fixtures: ['fixtures/calculator.mjs'],
      oracles: ['lib/oracles.mjs'],
      probes: ['probes/node24.mjs'],
      profiles: ['profiles/calculator.json'],
    };
    const environment = {
      schemaVersion: 1,
      environment: { repository: root, commit, tree },
      manifestPath: 'manifest.json',
      entrypoint: { path: 'bin/mdlm-phase1-qualify.mjs', argv: ['self-check'] },
      bindings,
    };
    const vai = {
      schemaVersion: 1,
      environment: environment.environment,
      manifestPath: 'manifest.json',
      bindings,
    };
    const envPath = path.join(root, 'env.json');
    const vaiPath = path.join(root, 'vai.json');
    writeFileSync(envPath, JSON.stringify(environment));
    writeFileSync(vaiPath, JSON.stringify(vai));

    const result = spawnSync(process.execPath, [cli, 'preflight', '--env', envPath, '--vai', vaiPath], {
      encoding: 'utf8',
    });

    assert.equal(result.status, 1);
    assert.match(result.stderr, /\.lifecycle\/ is forbidden/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
