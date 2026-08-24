import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';

const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

function signalProcess(pid, signal) {
  if (!pid) return false;
  try {
    process.kill(pid, signal);
    return true;
  } catch (error) {
    if (error.code === 'ESRCH') return false;
    throw error;
  }
}

function signalGroup(pid, signal) {
  if (!pid || process.platform === 'win32') return false;
  try {
    process.kill(-pid, signal);
    return true;
  } catch (error) {
    if (error.code === 'ESRCH') return false;
    throw error;
  }
}

function groupExists(pid) {
  if (!pid || process.platform === 'win32') return false;
  if (process.platform === 'linux') {
    const leader = processIdentity(pid);
    return leader !== null && leader.state !== 'Z' && leader.processGroup === pid;
  }
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    if (error.code === 'ESRCH') return false;
    if (error.code === 'EPERM') return true;
    throw error;
  }
}

function processIdentity(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return null;
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    return { state: fields[0], processGroup: Number(fields[2]), startTime: fields[19] };
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ESRCH') return null;
    if (process.platform !== 'linux') {
      try {
        process.kill(pid, 0);
        return { state: '?', startTime: '?' };
      } catch (killError) {
        if (killError.code === 'ESRCH') return null;
        throw killError;
      }
    }
    throw error;
  }
}

function sameProcess(pid, startTime, includeZombie = false) {
  const identity = processIdentity(pid);
  return identity !== null && (includeZombie || identity.state !== 'Z') && identity.startTime === startTime;
}

function childPids(pid) {
  if (process.platform !== 'linux') return [];
  try {
    return readFileSync(`/proc/${pid}/task/${pid}/children`, 'utf8')
      .trim().split(/\s+/).filter(Boolean).map(Number);
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ESRCH') return [];
    throw error;
  }
}

function discoverDescendants(rootPid, known) {
  if (process.platform !== 'linux' || !rootPid) return;
  const pending = [rootPid, ...known.keys()];
  const visited = new Set();
  while (pending.length > 0) {
    const pid = pending.pop();
    if (visited.has(pid)) continue;
    visited.add(pid);
    for (const childPid of childPids(pid)) {
      const identity = processIdentity(childPid);
      if (!identity) continue;
      if (childPid !== rootPid) known.set(childPid, identity.startTime);
      pending.push(childPid);
    }
  }
}

function signalKnown(known, signal) {
  let sent = false;
  for (const [pid, startTime] of known) {
    if (sameProcess(pid, startTime)) sent = signalProcess(pid, signal) || sent;
  }
  return sent;
}

function knownAlive(known) {
  return [...known].some(([pid, startTime]) => sameProcess(pid, startTime, true));
}

async function waitForCleanup(rootPid, known, milliseconds) {
  const end = Date.now() + milliseconds;
  do {
    discoverDescendants(rootPid, known);
    if (!groupExists(rootPid) && !knownAlive(known)) return true;
    await sleep(10);
  } while (Date.now() < end);
  return !groupExists(rootPid) && !knownAlive(known);
}

function boundedCollector(limit) {
  const chunks = [];
  let length = 0;
  let truncated = false;
  return {
    append(chunk) {
      const bytes = Buffer.from(chunk);
      const remaining = limit - length;
      if (remaining > 0) {
        const retained = bytes.subarray(0, remaining);
        chunks.push(retained);
        length += retained.length;
      }
      if (bytes.length > remaining) truncated = true;
    },
    buffer: () => Buffer.concat(chunks, length),
    truncated: () => truncated,
  };
}

export async function runExact(executable, argv, options = {}) {
  if (typeof executable !== 'string' || executable.length === 0) throw new TypeError('executable must be a nonempty string');
  if (!Array.isArray(argv) || argv.some((item) => typeof item !== 'string')) throw new TypeError('argv must contain only strings');
  const deadlineMs = options.deadlineMs ?? 5_000;
  const termGraceMs = options.termGraceMs ?? 250;
  const readinessDeadlineMs = options.readinessDeadlineMs ?? deadlineMs;
  const maxOutputBytes = options.maxOutputBytes ?? 1024 * 1024;
  if (!Number.isSafeInteger(deadlineMs) || deadlineMs <= 0) throw new TypeError('deadlineMs must be a positive integer');
  if (!Number.isSafeInteger(termGraceMs) || termGraceMs < 0) throw new TypeError('termGraceMs must be a nonnegative integer');
  if (!Number.isSafeInteger(readinessDeadlineMs) || readinessDeadlineMs <= 0) throw new TypeError('readinessDeadlineMs must be a positive integer');
  if (!Number.isSafeInteger(maxOutputBytes) || maxOutputBytes <= 0) throw new TypeError('maxOutputBytes must be a positive integer');
  if (options.readinessToken !== undefined && (typeof options.readinessToken !== 'string' || options.readinessToken.length === 0)) {
    throw new TypeError('readinessToken must be a nonempty string');
  }

  const stdout = boundedCollector(maxOutputBytes);
  const stderr = boundedCollector(maxOutputBytes);
  const known = new Map();
  let timedOut = false;
  let termSent = false;
  let killSent = false;
  let status = null;
  let signal = null;
  let spawnError = null;
  let ready = options.readinessToken === undefined;
  let readinessError = null;
  let deadlineTimer;
  let forceTimer;
  let readinessTimer;
  let tracker;

  const child = spawn(executable, argv, {
    cwd: options.cwd,
    env: options.env ?? process.env,
    detached: process.platform !== 'win32',
    shell: false,
    stdio: options.readinessToken === undefined ? ['ignore', 'pipe', 'pipe'] : ['ignore', 'pipe', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (chunk) => stdout.append(chunk));
  child.stderr.on('data', (chunk) => stderr.append(chunk));

  const exited = new Promise((resolve) => {
    child.once('error', (error) => {
      spawnError = error;
      resolve();
    });
    child.once('exit', (code, exitSignal) => {
      status = code;
      signal = exitSignal;
      resolve();
    });
  });

  const terminate = (terminationSignal) => {
    discoverDescendants(child.pid, known);
    const knownSent = signalKnown(known, terminationSignal);
    const groupSent = signalGroup(child.pid, terminationSignal);
    const rootSent = groupSent ? false : signalProcess(child.pid, terminationSignal);
    return knownSent || groupSent || rootSent;
  };
  const scheduleForce = () => {
    if (forceTimer) return;
    forceTimer = setTimeout(() => {
      killSent = terminate('SIGKILL') || killSent;
    }, termGraceMs);
  };
  const startDeadline = () => {
    deadlineTimer = setTimeout(() => {
      timedOut = true;
      termSent = terminate('SIGTERM') || termSent;
      scheduleForce();
    }, deadlineMs);
  };

  if (child.pid) tracker = setInterval(() => discoverDescendants(child.pid, known), 5);
  if (options.readinessToken === undefined) {
    startDeadline();
  } else {
    const readiness = boundedCollector(4096);
    child.stdio[3].on('data', (chunk) => {
      if (ready) return;
      readiness.append(chunk);
      const observed = readiness.buffer();
      const expected = Buffer.from(options.readinessToken);
      if (observed.equals(expected)) {
        ready = true;
        clearTimeout(readinessTimer);
        startDeadline();
      } else if (observed.length >= expected.length || readiness.truncated()) {
        readinessError = 'readiness handshake did not match';
        termSent = terminate('SIGTERM') || termSent;
        scheduleForce();
      }
    });
    readinessTimer = setTimeout(() => {
      if (!ready) {
        readinessError = 'readiness handshake timed out';
        termSent = terminate('SIGTERM') || termSent;
        scheduleForce();
      }
    }, readinessDeadlineMs);
  }

  await exited;
  clearTimeout(deadlineTimer);
  clearTimeout(forceTimer);
  clearTimeout(readinessTimer);
  clearInterval(tracker);
  discoverDescendants(child.pid, known);

  if (groupExists(child.pid) || knownAlive(known)) {
    termSent = terminate('SIGTERM') || termSent;
    const terminated = await waitForCleanup(child.pid, known, termGraceMs);
    if (!terminated) {
      killSent = terminate('SIGKILL') || killSent;
    }
  }
  let cleanupComplete = await waitForCleanup(child.pid, known, 1_000);
  if (!cleanupComplete) {
    killSent = terminate('SIGKILL') || killSent;
    cleanupComplete = await waitForCleanup(child.pid, known, 250);
  }

  child.stdout.destroy();
  child.stderr.destroy();
  if (options.readinessToken !== undefined) child.stdio[3].destroy();

  return {
    executable,
    argv: [...argv],
    status,
    signal,
    timedOut,
    ready,
    readinessError,
    termSent,
    killSent,
    cleanupComplete,
    spawnError: spawnError ? { code: spawnError.code, message: spawnError.message } : null,
    stdout: stdout.buffer(),
    stderr: stderr.buffer(),
    stdoutTruncated: stdout.truncated(),
    stderrTruncated: stderr.truncated(),
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
    ready: result.ready,
    readinessError: result.readinessError,
    termSent: result.termSent,
    killSent: result.killSent,
    cleanupComplete: result.cleanupComplete,
    spawnError: result.spawnError,
    stdoutTruncated: result.stdoutTruncated,
    stderrTruncated: result.stderrTruncated,
    stdoutBase64: result.stdout.toString('base64'),
    stderrBase64: result.stderr.toString('base64'),
  };
}
