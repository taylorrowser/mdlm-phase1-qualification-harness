import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createEvidenceWriter } from '../lib/evidence.mjs';

const suffix = (byte) => Buffer.alloc(16, byte);

test('evidence writing survives a deterministic name collision without touching the colliding directory', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'phase1-evidence-collision-'));
  try {
    const output = path.join(root, 'result.json');
    const collision = path.join(root, `.result.json.tmp-${suffix(0).toString('hex')}`);
    mkdirSync(collision, { mode: 0o700 });
    writeFileSync(path.join(collision, 'sentinel'), 'untouched');
    const values = [suffix(0), suffix(1)];
    const writeEvidence = createEvidenceWriter({ randomBytes: () => values.shift() });

    await writeEvidence(output, { pass: true });

    assert.equal(readFileSync(output, 'utf8'), '{\n  "pass": true\n}\n');
    assert.equal(readFileSync(path.join(collision, 'sentinel'), 'utf8'), 'untouched');
    assert.deepEqual(readdirSync(root).sort(), [path.basename(collision), 'result.json'].sort());
    assert.equal(statSync(collision).mode & 0o777, 0o700);
    assert.equal(statSync(output).mode & 0o777, 0o600);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('evidence writing surfaces cleanup failure after a successful atomic rename', async () => {
  const cleanupError = new Error('cleanup failed');
  const calls = [];
  const writeEvidence = createEvidenceWriter({
    randomBytes: () => suffix(2),
    mkdir: async (target, options) => calls.push(['mkdir', target, options]),
    writeFile: async (target, bytes, options) => calls.push(['writeFile', target, bytes, options]),
    rename: async (source, destination) => calls.push(['rename', source, destination]),
    rm: async (target, options) => { calls.push(['rm', target, options]); throw cleanupError; },
  });

  await assert.rejects(writeEvidence('/destination/result.json', { pass: true }), (error) => error === cleanupError);
  assert.equal(calls.filter(([operation]) => operation === 'rename').length, 1);
  assert.equal(calls.filter(([operation]) => operation === 'rm').length, 1);
});

test('evidence writing retains operation and cleanup failures', async () => {
  const operationError = new Error('rename failed');
  const cleanupError = new Error('cleanup failed');
  const writeEvidence = createEvidenceWriter({
    randomBytes: () => suffix(3),
    mkdir: async () => {},
    writeFile: async () => {},
    rename: async () => { throw operationError; },
    rm: async () => { throw cleanupError; },
  });

  await assert.rejects(writeEvidence('/destination/result.json', { pass: false }), (error) => {
    assert.ok(error instanceof AggregateError);
    assert.deepEqual(error.errors, [operationError, cleanupError]);
    return true;
  });
});
