import { spawn } from 'node:child_process';
import { appendFileSync, chmodSync, readFileSync, writeFileSync } from 'node:fs';

const [mode = 'observe', fixturePath] = process.argv.slice(2);

if (process.env.LAUNCH_MARKER) appendFileSync(process.env.LAUNCH_MARKER, 'launched\n');

if (mode === 'early-exit') process.exit(0);

if (mode === 'hang-with-descendant') {
  spawn(process.execPath, ['-e', "process.on('SIGTERM', () => {}); setInterval(() => {}, 1_000)"], { stdio: 'ignore' });
  process.on('SIGTERM', () => {});
  setInterval(() => {}, 1_000);
} else {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  const fixture = readFileSync(fixturePath);

  process.stdout.write(JSON.stringify({
    argv: process.argv.slice(2),
    stdinBase64: Buffer.concat(chunks).toString('base64'),
    fixtureBase64: fixture.toString('base64'),
    environment: {
      LANG: process.env.LANG ?? null,
      LC_ALL: process.env.LC_ALL ?? null,
      TZ: process.env.TZ ?? null,
      CASE_SENTINEL: process.env.CASE_SENTINEL ?? null,
      AMBIENT_SECRET: process.env.AMBIENT_SECRET ?? null,
      NODE_OPTIONS: process.env.NODE_OPTIONS ?? null,
    },
  }) + '\n');

  if (mode === 'mutate-fixture') {
    chmodSync(fixturePath, 0o600);
    writeFileSync(fixturePath, Buffer.from('changed'));
  }
  if (mode === 'block-workspace') chmodSync('.', 0o000);
  if (mode === 'nonzero') process.exitCode = 7;
}
