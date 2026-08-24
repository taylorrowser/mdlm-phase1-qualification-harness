import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

const cli = path.resolve('bin/mdlm-phase1-qualify.mjs');
const git = (cwd, ...args) => execFileSync('/usr/bin/git', args, { cwd, encoding: 'utf8' }).trim();

test('preflight rejects a Lifecycle Data repository used as an executable environment', () => {
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
    const environmentRef = `git-environment:v1;repository=${encodeURIComponent(root)};commit=${commit};tree=${tree};manifest=manifest.json;manifest-git-blob=${'0'.repeat(40)};manifest-sha256=${'0'.repeat(64)}`;
    const env = {
      type: 'ENV', payload: {
        title: 'Invalid lifecycle environment', rationale: 'This must be rejected before execution.',
        strategy_revision: 'VSP-N4Z1K7J19T-r00001', profile_id: 'calculator-cli-bootstrap',
        capabilities: { controllability: ['controlled'], observability: ['observed'], external_services: [], timing: 'guard only' },
        reproducibility: { environment_ref: environmentRef, configuration_digest: `sha256:${'0'.repeat(64)}`, reconstruction: 'Exact blobs only.' },
      },
    };
    const vai = {
      type: 'VAI', payload: {
        title: 'Invalid implementation', rationale: 'This must be rejected before execution.',
        kind: 'qualification', implementation_ref: `git:${commit}`, independence_mode: 'environment-capability',
        authoring_input_refs: ['VSP-N4Z1K7J19T-r00001'],
        prohibited_inputs_observed: ['product source code', 'product unit tests', 'private implementation details', 'uncontrolled implementation shortcuts'],
        activity_bindings: [`asset:v1;role=manifest;path=manifest.json;git-blob=${'0'.repeat(40)};sha256=${'0'.repeat(64)}`],
        target_behavior: { supported: ['controlled'], intentionally_unsupported: ['product acceptance'] },
      },
    };
    const envPath = path.join(root, 'env.json');
    const vaiPath = path.join(root, 'vai.json');
    writeFileSync(envPath, JSON.stringify(env));
    writeFileSync(vaiPath, JSON.stringify(vai));
    const result = spawnSync(process.execPath, [cli, 'preflight', '--env', envPath, '--vai', vaiPath], { encoding: 'utf8' });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /\.lifecycle\/ is forbidden/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
