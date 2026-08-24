import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

const root = path.resolve('.');
const baseline = '3033e3de6f356d5059d618ac9e2ca4fb7fefc3da';

test('generator emits a directly preflightable realize-verification-environment response', () => {
  const temporary = mkdtempSync(path.join(tmpdir(), 'phase1-generate-'));
  try {
    const strategy = path.join(temporary, 'strategy.json');
    const output = path.join(temporary, 'response.json');
    writeFileSync(strategy, JSON.stringify({
      type: 'VSP', revision_id: 'VSP-N4Z1K7J19T-r00001', payload: {
        environment_profile: {
          id: 'calculator-cli-bootstrap',
          capabilities: {
            controllability: ['Run exact argument vectors without a shell.'],
            observability: ['Capture separate bounded raw streams and status.'],
            external_services: [],
            timing: 'Deadlines guard infrastructure execution only.',
          },
        },
      },
    }));
    const generated = spawnSync(process.execPath, [path.join(root, 'tools/generate-preflight-inputs.mjs'),
      '--repository', root, '--commit', baseline,
      '--assignment', '00000000-0000-4000-8000-000000000000',
      '--strategy', strategy, '--output', output,
    ], { encoding: 'utf8', timeout: 15_000 });
    assert.equal(generated.status, 0, generated.stderr);
    const response = JSON.parse(readFileSync(output, 'utf8'));
    assert.equal(response.contract, 'mdlm-assignment-response@1');
    assert.deepEqual(response.proposal.outputs.map(({ name }) => name), ['environment', 'qualification_activity', 'qualification_implementation']);
    assert.match(response.proposal.outputs[0].lifecycleDatum.payload.reproducibility.environment_ref, /^git-environment:v1;/);
    assert.equal(response.proposal.outputs[2].lifecycleDatum.payload.activity_bindings.some((value) => value.includes('$proposal')), false);

    const checked = spawnSync(process.execPath, [path.join(root, 'bin/mdlm-phase1-qualify.mjs'), 'preflight', '--proposal', output], {
      encoding: 'utf8', timeout: 15_000,
    });
    assert.equal(checked.status, 0, checked.stderr);
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});
