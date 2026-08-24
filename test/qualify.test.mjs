import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const root = path.resolve('.');

test('qualification probes raw behavior and discriminates nonconforming fixtures', () => {
  const temporary = mkdtempSync(path.join(tmpdir(), 'phase1-qualify-'));
  try {
    const output = path.join(temporary, 'evidence.json');
    const markerLog = path.join(temporary, 'node-options.log');
    const marker = path.join(temporary, 'marker.cjs');
    writeFileSync(marker, `require('node:fs').appendFileSync(${JSON.stringify(markerLog)}, String(process.pid) + '\\n');\n`);
    const result = spawnSync(process.execPath, [
      path.join(root, 'bin/mdlm-phase1-qualify.mjs'), 'qualify',
      '--config', path.join(root, 'config/qualification.json'), '--output', output,
    ], { encoding: 'utf8', env: { ...process.env, NODE_OPTIONS: `--require=${marker}` } });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(readFileSync(markerLog, 'utf8').trim().split('\n').length, 1, 'NODE_OPTIONS preload reached a qualification child');
    const evidence = JSON.parse(readFileSync(output, 'utf8'));
    assert.equal(evidence.pass, true);
    assert.deepEqual(evidence.runtime, { executable: process.execPath, nodeVersion: process.versions.node });
    assert.equal(evidence.probes.find(({ id }) => id === 'raw-streams').observation.stdoutBase64, 'AP8=');
    assert.equal(evidence.negativeControls.every(({ discriminated }) => discriminated), true);
    assert.equal(evidence.cases.some(({ argv }) => argv.includes('')), true);
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});
