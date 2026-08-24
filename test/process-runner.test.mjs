import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { nodeChildEnvironment, runCases, runExact } from '../lib/process-runner.mjs';

test('runner preserves separate raw streams, exit status, and empty argv', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'phase1-raw-'));
  try {
    const script = path.join(root, 'raw.mjs');
    writeFileSync(script, "process.stdout.write(Buffer.from([0,255])); process.stderr.write(Buffer.from(process.argv.slice(2).join('|'))); process.exit(7);\n");
    const omitted = await runExact(process.execPath, [script], { deadlineMs: 1_000 });
    const empty = await runExact(process.execPath, [script, ''], { deadlineMs: 1_000 });
    assert.deepEqual(omitted.stdout, Buffer.from([0, 255]));
    assert.deepEqual(omitted.stderr, Buffer.alloc(0));
    assert.equal(omitted.status, 7);
    assert.deepEqual(empty.stderr, Buffer.from(''));
    assert.deepEqual(empty.argv, [script, '']);
    assert.notDeepEqual(omitted.argv, empty.argv);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('runner gives Node children only required platform variables', async () => {
  const result = await runExact(process.execPath, ['-e', 'process.stdout.write(JSON.stringify(process.env))'], {
    deadlineMs: 1_000,
  });
  assert.equal(result.status, 0);
  assert.deepEqual(JSON.parse(result.stdout.toString('utf8')), nodeChildEnvironment());
  assert.equal(Object.hasOwn(JSON.parse(result.stdout.toString('utf8')), 'NODE_OPTIONS'), false);
});

test('runner strips NODE_OPTIONS from an explicit child environment', async () => {
  const result = await runExact(process.execPath, ['-e', "process.stdout.write(process.env.SENTINEL + ':' + String(process.env.NODE_OPTIONS))"], {
    deadlineMs: 1_000,
    env: { SENTINEL: 'retained', NODE_OPTIONS: '--require=/does/not/exist' },
  });
  assert.equal(result.status, 0, result.stderr.toString('utf8'));
  assert.equal(result.stdout.toString('utf8'), 'retained:undefined');
});

test('deadline starts after readiness, retains evidence, and reaps descendants', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'phase1-deadline-'));
  try {
    const pidFile = path.join(root, 'pid');
    const script = path.join(root, 'hang.mjs');
    writeFileSync(script, `
      import { spawn } from 'node:child_process';
      import { writeFileSync } from 'node:fs';
      process.on('SIGTERM', () => process.stderr.write('term\\n'));
      const child = spawn(process.execPath, ['-e', "process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"], { stdio: 'ignore' });
      writeFileSync(${JSON.stringify(pidFile)}, String(child.pid));
      process.stdout.write('partial\\n');
      process._getActiveHandles();
      writeFileSync(3, 'READY\\n');
      setInterval(() => {}, 1000);
    `);
    const result = await runExact(process.execPath, [script], {
      deadlineMs: 75,
      readinessToken: 'READY\n',
      readinessDeadlineMs: 1_000,
      termGraceMs: 100,
    });
    assert.equal(result.ready, true);
    assert.equal(result.timedOut, true);
    assert.equal(result.termSent, true);
    assert.equal(result.killSent, true);
    assert.equal(result.cleanupComplete, true);
    assert.equal(result.stdout.toString(), 'partial\n');
    assert.match(result.stderr.toString(), /term/);
    const descendantPid = Number(readFileSync(pidFile, 'utf8'));
    assert.throws(() => process.kill(descendantPid, 0), { code: 'ESRCH' });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('timeout returns with bounded streams after a detached descendant inherits its pipes', { skip: process.platform !== 'linux' }, async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'phase1-escaped-'));
  try {
    const pidFile = path.join(root, 'pid');
    const script = path.join(root, 'escape.mjs');
    writeFileSync(script, `
      import { spawn } from 'node:child_process';
      import { writeFileSync } from 'node:fs';
      const child = spawn(process.execPath, ['-e', "require('node:fs').writeFileSync(3,'CHILD-READY\\\\n');process.on('SIGTERM',()=>{});process.stdout.write('x'.repeat(10000));setInterval(()=>{},1000)"],
        { detached: true, stdio: ['ignore', process.stdout, process.stderr, 'pipe'] });
      writeFileSync(${JSON.stringify(pidFile)}, String(child.pid));
      child.stdio[3].once('data', () => writeFileSync(3, 'READY\\n'));
      setInterval(() => {}, 1000);
    `);
    const started = Date.now();
    const result = await runExact(process.execPath, [script], {
      deadlineMs: 50,
      readinessToken: 'READY\n',
      readinessDeadlineMs: 1_000,
      termGraceMs: 50,
      maxOutputBytes: 128,
    });
    assert.ok(Date.now() - started < 2_000);
    assert.equal(result.timedOut, true);
    assert.equal(result.cleanupComplete, true);
    assert.equal(result.stdout.length, 128);
    assert.equal(result.stdoutTruncated, true);
    const descendantPid = Number(readFileSync(pidFile, 'utf8'));
    assert.throws(() => process.kill(descendantPid, 0), { code: 'ESRCH' });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('runner aggregates every case after failures', async () => {
  const cases = [
    { id: 'fail', executable: process.execPath, argv: ['-e', 'process.exit(3)'] },
    { id: 'later', executable: process.execPath, argv: ['-e', "process.stdout.write('ran')"] },
  ];
  const results = await runCases(cases, { deadlineMs: 1_000 });
  assert.equal(results.length, 2);
  assert.equal(results[0].status, 3);
  assert.equal(results[1].stdout.toString(), 'ran');
});
