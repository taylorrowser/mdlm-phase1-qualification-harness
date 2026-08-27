import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
const windowsPlatformVariables = new Set(['COMSPEC', 'SYSTEMROOT', 'TEMP', 'TMP', 'WINDIR']);

export function nodeChildEnvironment(source = process.env) {
  if (process.platform !== 'win32') return {};
  return Object.fromEntries(Object.entries(source).filter(([name, value]) =>
    windowsPlatformVariables.has(name.toUpperCase()) && typeof value === 'string'));
}

function withoutNodeOptions(environment) {
  return Object.fromEntries(Object.entries(environment).filter(([name]) => name.toUpperCase() !== 'NODE_OPTIONS'));
}

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
  const streamDrainMs = options.streamDrainMs ?? 250;
  const maxCleanupWaitMs = options.maxCleanupWaitMs ?? 1_000;
  if (!Number.isSafeInteger(deadlineMs) || deadlineMs <= 0) throw new TypeError('deadlineMs must be a positive integer');
  if (!Number.isSafeInteger(termGraceMs) || termGraceMs < 0) throw new TypeError('termGraceMs must be a nonnegative integer');
  if (!Number.isSafeInteger(readinessDeadlineMs) || readinessDeadlineMs <= 0) throw new TypeError('readinessDeadlineMs must be a positive integer');
  if (!Number.isSafeInteger(maxOutputBytes) || maxOutputBytes <= 0) throw new TypeError('maxOutputBytes must be a positive integer');
  if (!Number.isSafeInteger(streamDrainMs) || streamDrainMs < 0) throw new TypeError('streamDrainMs must be a nonnegative integer');
  if (!Number.isSafeInteger(maxCleanupWaitMs) || maxCleanupWaitMs < 0) throw new TypeError('maxCleanupWaitMs must be a nonnegative integer');
  if (options.readinessToken !== undefined && (typeof options.readinessToken !== 'string' || options.readinessToken.length === 0)) {
    throw new TypeError('readinessToken must be a nonempty string');
  }
  const stdinSupplied = Object.hasOwn(options, 'stdin');
  if (stdinSupplied && !Buffer.isBuffer(options.stdin)) throw new TypeError('stdin must be a Buffer');
  const stdinBytes = stdinSupplied ? Buffer.from(options.stdin) : null;

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
  let cleanupStartedAt = null;
  let settleStdin;
  let stdinSettled = !stdinSupplied;
  const stdin = stdinSupplied ? {
    supplied: true,
    expectedBytes: stdinBytes.length,
    writtenBytes: 0,
    sha256: createHash('sha256').update(stdinBytes).digest('hex'),
    eof: 'pending',
    complete: false,
    error: null,
  } : {
    supplied: false,
    expectedBytes: null,
    writtenBytes: null,
    sha256: null,
    eof: 'not-supplied',
    complete: true,
    error: null,
  };
  const stdinFinished = stdinSupplied ? new Promise((resolve) => { settleStdin = resolve; }) : Promise.resolve();

  const child = spawn(executable, argv, {
    cwd: options.cwd,
    env: options.env === undefined ? nodeChildEnvironment() : withoutNodeOptions(options.env),
    detached: process.platform !== 'win32',
    shell: false,
    stdio: options.readinessToken === undefined
      ? [stdinSupplied ? 'pipe' : 'ignore', 'pipe', 'pipe']
      : [stdinSupplied ? 'pipe' : 'ignore', 'pipe', 'pipe', 'pipe'],
  });
  let childClose = false;
  let stdoutEnded = false;
  let stderrEnded = false;
  child.stdout.on('data', (chunk) => stdout.append(chunk));
  child.stderr.on('data', (chunk) => stderr.append(chunk));
  const stdoutFinished = new Promise((resolve) => child.stdout.once('end', () => {
    stdoutEnded = true;
    resolve();
  }));
  const stderrFinished = new Promise((resolve) => child.stderr.once('end', () => {
    stderrEnded = true;
    resolve();
  }));
  const childClosed = new Promise((resolve) => child.once('close', () => {
    childClose = true;
    resolve();
  }));
  const streamsFinished = Promise.all([childClosed, stdoutFinished, stderrFinished]);

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

  const finishStdin = (error) => {
    if (stdinSettled) return;
    stdinSettled = true;
    if (error) {
      stdin.eof = 'write-failed';
      stdin.complete = false;
      stdin.error = {
        code: 'STDIN_WRITE_INCOMPLETE',
        cause: timedOut ? 'PROCESS_TIMEOUT' : (error.code ?? 'ERR_STREAM_DESTROYED'),
      };
    } else {
      stdin.eof = 'closed';
      stdin.complete = true;
      stdin.error = null;
    }
    settleStdin();
  };

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
      cleanupStartedAt ??= Date.now();
      termSent = terminate('SIGTERM') || termSent;
      scheduleForce();
    }, deadlineMs);
  };

  if (child.pid) tracker = setInterval(() => discoverDescendants(child.pid, known), 5);
  if (stdinSupplied) {
    const writeNext = () => {
      if (stdinSettled) return;
      if (stdin.writtenBytes === stdin.expectedBytes) {
        child.stdin.end((error) => finishStdin(error));
        return;
      }
      const end = Math.min(stdin.writtenBytes + 64 * 1024, stdin.expectedBytes);
      const chunk = stdinBytes.subarray(stdin.writtenBytes, end);
      child.stdin.write(chunk, (error) => {
        if (error) {
          finishStdin(error);
          return;
        }
        stdin.writtenBytes = end;
        writeNext();
      });
    };
    child.stdin.on('error', finishStdin);
    writeNext();
  }
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
        cleanupStartedAt ??= Date.now();
        termSent = terminate('SIGTERM') || termSent;
        scheduleForce();
      }
    });
    readinessTimer = setTimeout(() => {
      if (!ready) {
        readinessError = 'readiness handshake timed out';
        cleanupStartedAt ??= Date.now();
        termSent = terminate('SIGTERM') || termSent;
        scheduleForce();
      }
    }, readinessDeadlineMs);
  }

  await exited;
  if (stdinSupplied && !stdinSettled) {
    finishStdin(Object.assign(new Error('stdin closed before every byte and EOF were accepted'), {
      code: timedOut ? 'PROCESS_TIMEOUT' : 'ERR_STREAM_DESTROYED',
    }));
  }
  await stdinFinished;
  clearTimeout(deadlineTimer);
  clearTimeout(forceTimer);
  clearTimeout(readinessTimer);
  clearInterval(tracker);

  // Node may emit exit before inherited stdio closes. Give descendants a bounded
  // chance to finish and drain their bytes before cleanup signals them.
  await Promise.race([streamsFinished, sleep(streamDrainMs)]);
  discoverDescendants(child.pid, known);

  const cleanupNeeded = groupExists(child.pid) || knownAlive(known);
  let cleanupComplete = !cleanupNeeded &&
    (cleanupStartedAt === null || Date.now() - cleanupStartedAt <= maxCleanupWaitMs);
  if (cleanupNeeded) {
    cleanupStartedAt ??= Date.now();
    termSent = terminate('SIGTERM') || termSent;
    if (maxCleanupWaitMs > 0) cleanupComplete = await waitForCleanup(child.pid, known, Math.min(termGraceMs, maxCleanupWaitMs));
    if (!cleanupComplete) {
      killSent = terminate('SIGKILL') || killSent;
      const remaining = Math.max(0, maxCleanupWaitMs - Math.min(termGraceMs, maxCleanupWaitMs));
      if (remaining > 0) cleanupComplete = await waitForCleanup(child.pid, known, remaining);
    }
  }

  // Evidence keeps the caller's cleanup bound, but safety cleanup continues
  // before workspace teardown even when that bound was missed.
  let safetyCleanupComplete = await waitForCleanup(child.pid, known, 1_000);
  if (!safetyCleanupComplete) {
    killSent = terminate('SIGKILL') || killSent;
    safetyCleanupComplete = await waitForCleanup(child.pid, known, 250);
  }
  if (!safetyCleanupComplete) cleanupComplete = false;

  await Promise.race([streamsFinished, sleep(streamDrainMs)]);
  const streamsComplete = childClose && stdoutEnded && stderrEnded;
  if (!streamsComplete) {
    child.stdout.destroy();
    child.stderr.destroy();
  }
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
    streams: { childClose, stdoutEnded, stderrEnded, complete: streamsComplete },
    spawnError: spawnError ? { code: spawnError.code, message: spawnError.message } : null,
    stdout: stdout.buffer(),
    stderr: stderr.buffer(),
    stdoutTruncated: stdout.truncated(),
    stderrTruncated: stderr.truncated(),
    stdin,
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
    streams: result.streams,
    spawnError: result.spawnError,
    stdin: result.stdin,
    stdoutTruncated: result.stdoutTruncated,
    stderrTruncated: result.stderrTruncated,
    stdoutBase64: result.stdout.toString('base64'),
    stderrBase64: result.stderr.toString('base64'),
  };
}
