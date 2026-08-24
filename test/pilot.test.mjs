import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
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
      const result = spawnSync(process.execPath, [cli, 'pilot', '--profile', path.join(root, `profiles/${name}.json`), '--repository', repository, '--commit', commit, '--output', output], {
        encoding: 'utf8', timeout: 15_000,
      });
      assert.equal(result.status, 0, result.stderr);
      const evidence = JSON.parse(readFileSync(output, 'utf8'));
      assert.equal(evidence.pass, true);
      assert.equal(evidence.commit, commit);
      assert.equal(evidence.cases.length, 4);
      assert.equal(evidence.cases.every(({ pass }) => pass), true);
    } finally {
      rmSync(temporary, { recursive: true, force: true });
    }
  });
}
