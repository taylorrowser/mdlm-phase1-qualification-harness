import { spawn } from 'node:child_process';

const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

function signalGroup(pid, signal) {
  if (!pid) return false;
  try {
    process.kill(-pid, signal);
    return true;
  } catch (error) {
    if (error.code === 'ESRCH') return false;
    throw error;
  }
}

function groupExists(pid) {
  if (!pid) return false;
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    if (error.code === 'ESRCH') return false;
    if (error.code === 'EPERM') return true;
    throw error;
  }
}

async function waitForGroupExit(pid, milliseconds) {
  const end = Date.now() + milliseconds;
  while (groupExists(pid) && Date.now() < end) await sleep(10);
  return !groupExists(pid);
}

export async function runExact(executable, argv, options = {}) {
  if (typeof executable !== 'string' || executable.length === 0) throw new TypeError('executable must be a nonempty string');
  if (!Array.isArray(argv) || argv.some((item) => typeof item !== 'string')) throw new TypeError('argv must contain only strings');
  const deadlineMs = options.deadlineMs ?? 5_000;
  const termGraceMs = options.termGraceMs ?? 250;
  if (!Number.isSafeInteger(deadlineMs) || deadlineMs <= 0) throw new TypeError('deadlineMs must be a positive integer');
  if (!Number.isSafeInteger(termGraceMs) || termGraceMs < 0) throw new TypeError('termGraceMs must be a nonnegative integer');

  const stdout = [];
  const stderr = [];
  let timedOut = false;
  let termSent = false;
  let killSent = false;
  let status = null;
  let signal = null;
  let spawnError = null;
  let graceTimer;

  const child = spawn(executable, argv, {
    cwd: options.cwd,
    env: options.env ?? process.env,
    detached: true,
    shell: false,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (chunk) => stdout.push(Buffer.from(chunk)));
  child.stderr.on('data', (chunk) => stderr.push(Buffer.from(chunk)));
  child.on('error', (error) => { spawnError = error; });
  child.on('exit', (code, exitSignal) => {
    status = code;
    signal = exitSignal;
    if (!timedOut && groupExists(child.pid)) signalGroup(child.pid, 'SIGTERM');
  });

  const deadlineTimer = setTimeout(() => {
    timedOut = true;
    termSent = signalGroup(child.pid, 'SIGTERM');
    graceTimer = setTimeout(() => {
      killSent = signalGroup(child.pid, 'SIGKILL');
    }, termGraceMs);
  }, deadlineMs);

  await new Promise((resolve) => child.once('close', resolve));
  clearTimeout(deadlineTimer);
  if (timedOut && groupExists(child.pid)) {
    const termFinished = await waitForGroupExit(child.pid, termGraceMs);
    if (!termFinished) killSent = signalGroup(child.pid, 'SIGKILL') || killSent;
  }
  clearTimeout(graceTimer);
  if (groupExists(child.pid)) {
    termSent = signalGroup(child.pid, 'SIGTERM') || termSent;
    await sleep(termGraceMs);
    killSent = signalGroup(child.pid, 'SIGKILL') || killSent;
  }
  await waitForGroupExit(child.pid, 1_000);

  return {
    executable,
    argv: [...argv],
    status,
    signal,
    timedOut,
    termSent,
    killSent,
    spawnError: spawnError ? { code: spawnError.code, message: spawnError.message } : null,
    stdout: Buffer.concat(stdout),
    stderr: Buffer.concat(stderr),
  };
}

export async function runCases(cases, defaults = {}) {
  const results = [];
  for (const definition of cases) {
    const result = await runExact(definition.executable, definition.argv, {
      ...defaults,
      cwd: definition.cwd ?? defaults.cwd,
      env: definition.env ?? defaults.env,
      deadlineMs: definition.deadlineMs ?? defaults.deadlineMs,
      termGraceMs: definition.termGraceMs ?? defaults.termGraceMs,
    });
    results.push({ id: definition.id, ...result });
  }
  return results;
}

export function serializeObservation(result) {
  return {
    id: result.id,
    executable: result.executable,
    argv: result.argv,
    status: result.status,
    signal: result.signal,
    timedOut: result.timedOut,
    termSent: result.termSent,
    killSent: result.killSent,
    spawnError: result.spawnError,
    stdoutBase64: result.stdout.toString('base64'),
    stderrBase64: result.stderr.toString('base64'),
  };
}
