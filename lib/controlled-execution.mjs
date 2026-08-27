import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { chmod, lstat, mkdir, mkdtemp, open, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { authenticateRunnerIdentity, gitBlobId, profileIdentity, sha256 } from './execution-identity.mjs';
import { fetchExactRepository, readBlob, requireRegularBlob } from './git-objects.mjs';
import { nodeChildEnvironment, runExact, serializeObservation } from './process-runner.mjs';

const implementedCapabilities = ['controlled-execution@1', 'execution-profile@1'];
const safeModes = new Set(['0400', '0500', '0600']);
const objectIdPattern = /^[0-9a-f]{40}$/;
const sha256Pattern = /^[0-9a-f]{64}$/;
const environmentNamePattern = /^[A-Za-z_][A-Za-z0-9_]*$/;

class ControlledCaseError extends Error {
  constructor(stage, code, message, details) {
    super(message);
    this.stage = stage;
    this.code = code;
    this.details = details;
  }
}

function typedError(error, fallbackStage = 'setup', fallbackCode = 'CONTROLLED_CASE_FAILED') {
  return {
    stage: error.stage ?? fallbackStage,
    code: error instanceof ControlledCaseError ? error.code : fallbackCode,
    message: error.message,
    ...(error.details === undefined ? {} : { details: error.details }),
  };
}

function fail(stage, code, message, details) {
  throw new ControlledCaseError(stage, code, message, details);
}

function digest(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function decodeCanonical(value, label, code) {
  if (typeof value !== 'string' || Buffer.from(value, 'base64').toString('base64') !== value) {
    fail('setup', code, `${label} bytesBase64 is not canonical base64`);
  }
  return Buffer.from(value, 'base64');
}

function validateDigest(bytes, expected, label, code) {
  if (!sha256Pattern.test(expected ?? '') || digest(bytes) !== expected) {
    fail('setup', code, `${label} SHA-256 does not match its bytes`);
  }
}

function safeRelativePath(value, maxBytes, label = 'fixture') {
  if (typeof value !== 'string' || value.length === 0 || value.includes('\0') || value.includes('\\') ||
      path.posix.isAbsolute(value) || path.posix.normalize(value) !== value || value === '.' ||
      value.split('/').some((part) => part === '' || part === '.' || part === '..')) {
    fail('setup', 'UNSAFE_FIXTURE_PATH', `${label} path is not a canonical safe relative path`);
  }
  if (Buffer.byteLength(value) > maxBytes) fail('setup', 'FIXTURE_PATH_TOO_LONG', `${label} path exceeds maxPathBytes`);
  return value;
}

function positiveLimit(value, name, allowZero = false) {
  if (!Number.isSafeInteger(value) || value < (allowZero ? 0 : 1)) {
    fail('setup', 'INVALID_EXECUTION_PROFILE', `${name} must be ${allowZero ? 'a nonnegative' : 'a positive'} integer`);
  }
  return value;
}

function validateEnvironment(environment) {
  if (!environment || typeof environment !== 'object' || Array.isArray(environment)) {
    fail('setup', 'INVALID_EXECUTION_PROFILE', 'execution environment must be an object');
  }
  const attested = {};
  for (const name of ['LANG', 'LC_ALL', 'TZ']) {
    if (typeof environment[name] !== 'string' || environment[name].length === 0) {
      fail('setup', 'INVALID_EXECUTION_PROFILE', `execution environment must declare ${name}`);
    }
    attested[name] = environment[name];
  }
  const variables = environment.variables ?? {};
  if (!variables || typeof variables !== 'object' || Array.isArray(variables)) {
    fail('setup', 'INVALID_EXECUTION_PROFILE', 'execution environment variables must be an object');
  }
  const declared = {};
  for (const [name, value] of Object.entries(variables)) {
    if (!environmentNamePattern.test(name) || typeof value !== 'string') {
      fail('setup', 'INVALID_EXECUTION_PROFILE', `invalid execution environment variable ${name}`);
    }
    if (name.toUpperCase() === 'NODE_OPTIONS') {
      fail('setup', 'UNSUPPORTED_ENVIRONMENT_VARIABLE', 'NODE_OPTIONS cannot be supplied to controlled execution', { variable: name });
    }
    if (['LANG', 'LC_ALL', 'TZ'].includes(name)) {
      fail('setup', 'UNSUPPORTED_ENVIRONMENT_VARIABLE', `${name} must use its fixed execution-profile field`, { variable: name });
    }
    declared[name] = value;
  }
  return { ...attested, variables: declared };
}

function validateTargetDeclaration(target, entrypoint) {
  const declared = target?.entrypoint;
  if (typeof target?.repository !== 'string' || target.repository.length === 0 ||
      !objectIdPattern.test(target.commit ?? '') || !objectIdPattern.test(target.tree ?? '') ||
      !declared || declared.path !== entrypoint.path || declared.runtime !== entrypoint.runtime ||
      !['100644', '100755'].includes(declared.gitMode) || !objectIdPattern.test(declared.gitBlob ?? '') ||
      !sha256Pattern.test(declared.sha256 ?? '')) {
    fail('setup', 'UNAUTHENTICATED_IDENTITY', 'target must declare exact repository, commit, tree, mode, blob, digest, runtime, and path pins');
  }
  if (declared.runtime === 'executable' && declared.gitMode !== '100755') {
    fail('setup', 'UNAUTHENTICATED_IDENTITY', 'an executable target requires a Git-authenticated executable mode');
  }
  return target;
}

function validateRequest(request) {
  if (!request || typeof request !== 'object' || Array.isArray(request) || request.schemaVersion !== 1) {
    fail('setup', 'INVALID_CONTROLLED_CASE_REQUEST', 'controlled case request schemaVersion must be 1');
  }
  const required = request.capabilities?.required;
  if (!Array.isArray(required) || required.some((capability) => typeof capability !== 'string')) {
    fail('setup', 'INVALID_CONTROLLED_CASE_REQUEST', 'required capabilities must be an array of strings');
  }
  for (const capability of required) {
    if (!implementedCapabilities.includes(capability)) {
      fail('setup', 'UNSUPPORTED_CAPABILITY', `unsupported controlled execution capability: ${capability}`, { capability });
    }
  }
  if (request.identities !== undefined) {
    fail('setup', 'UNAUTHENTICATED_IDENTITY', 'caller-supplied runner, adapter, target, and profile identities are not accepted');
  }

  const profile = request.executionProfile;
  if (!profile || profile.schemaVersion !== 1 || typeof profile.id !== 'string' || profile.id.length === 0 || !profile.entrypoint || !profile.limits) {
    fail('setup', 'INVALID_EXECUTION_PROFILE', 'execution profile schemaVersion, id, entrypoint, and limits are required');
  }
  const limits = {
    deadlineMs: positiveLimit(profile.limits.deadlineMs, 'deadlineMs'),
    termGraceMs: positiveLimit(profile.limits.termGraceMs, 'termGraceMs', true),
    maxCleanupWaitMs: profile.limits.maxCleanupWaitMs === undefined ? 1_000 : positiveLimit(profile.limits.maxCleanupWaitMs, 'maxCleanupWaitMs', true),
    streamDrainMs: profile.limits.streamDrainMs === undefined ? 250 : positiveLimit(profile.limits.streamDrainMs, 'streamDrainMs', true),
    maxPathBytes: positiveLimit(profile.limits.maxPathBytes, 'maxPathBytes'),
    maxFixtureBytes: positiveLimit(profile.limits.maxFixtureBytes, 'maxFixtureBytes'),
    maxAggregateFixtureBytes: positiveLimit(profile.limits.maxAggregateFixtureBytes, 'maxAggregateFixtureBytes'),
    maxStdinBytes: positiveLimit(profile.limits.maxStdinBytes, 'maxStdinBytes'),
    maxOutputBytes: profile.limits.maxOutputBytes === undefined ? 1024 * 1024 : positiveLimit(profile.limits.maxOutputBytes, 'maxOutputBytes'),
  };
  const environment = validateEnvironment(profile.environment);
  const entrypoint = profile.entrypoint;
  if (!['node', 'executable'].includes(entrypoint.runtime)) fail('setup', 'UNSUPPORTED_ENTRYPOINT_RUNTIME', 'entrypoint runtime must be node or executable');
  const entrypointPath = safeRelativePath(entrypoint.path, limits.maxPathBytes, 'entrypoint');
  if (entrypoint.mode !== '0500') fail('setup', 'UNSUPPORTED_ENTRYPOINT_MODE', 'materialized entrypoint mode must be 0500');
  const entrypointBytes = decodeCanonical(entrypoint.bytesBase64, 'entrypoint', 'NONCANONICAL_ENTRYPOINT_BASE64');
  validateDigest(entrypointBytes, entrypoint.sha256, 'entrypoint', 'ENTRYPOINT_DIGEST_MISMATCH');
  const target = validateTargetDeclaration(request.target, entrypoint);

  const definition = request.case;
  if (!definition || typeof definition.id !== 'string' || !Array.isArray(definition.argv) ||
      definition.argv.some((value) => typeof value !== 'string') || !Array.isArray(definition.fixtures)) {
    fail('setup', 'INVALID_CONTROLLED_CASE', 'case id, argv, and fixtures are required');
  }
  const seen = new Set([entrypointPath]);
  const fixtures = [];
  let aggregateBytes = 0;
  for (const declared of definition.fixtures) {
    if (!declared || typeof declared !== 'object' || (declared.kind !== undefined && declared.kind !== 'file')) {
      fail('setup', 'UNSUPPORTED_FIXTURE_TYPE', 'only regular-file fixtures are supported');
    }
    const fixturePath = safeRelativePath(declared.path, limits.maxPathBytes);
    if (seen.has(fixturePath)) fail('setup', 'DUPLICATE_FIXTURE_PATH', `duplicate fixture path: ${fixturePath}`);
    for (const prior of seen) {
      if (fixturePath.startsWith(`${prior}/`) || prior.startsWith(`${fixturePath}/`)) {
        fail('setup', 'UNSAFE_FIXTURE_PATH', `fixture path conflicts with another materialized path: ${fixturePath}`);
      }
    }
    seen.add(fixturePath);
    if (!safeModes.has(declared.mode)) fail('setup', 'UNSUPPORTED_FIXTURE_MODE', `unsupported fixture mode: ${declared.mode}`);
    const bytes = decodeCanonical(declared.bytesBase64, `fixture ${fixturePath}`, 'NONCANONICAL_FIXTURE_BASE64');
    validateDigest(bytes, declared.sha256, `fixture ${fixturePath}`, 'FIXTURE_DIGEST_MISMATCH');
    if (bytes.length > limits.maxFixtureBytes) fail('setup', 'FIXTURE_TOO_LARGE', `fixture exceeds maxFixtureBytes: ${fixturePath}`);
    aggregateBytes += bytes.length;
    if (aggregateBytes > limits.maxAggregateFixtureBytes) fail('setup', 'FIXTURE_AGGREGATE_TOO_LARGE', 'fixtures exceed maxAggregateFixtureBytes');
    fixtures.push({ path: fixturePath, mode: declared.mode, bytes, sha256: declared.sha256 });
  }

  let stdin;
  if (definition.stdin !== undefined) {
    const bytes = decodeCanonical(definition.stdin?.bytesBase64, 'stdin', 'NONCANONICAL_STDIN_BASE64');
    validateDigest(bytes, definition.stdin?.sha256, 'stdin', 'STDIN_DIGEST_MISMATCH');
    if (bytes.length > limits.maxStdinBytes) fail('setup', 'STDIN_TOO_LARGE', 'stdin exceeds maxStdinBytes');
    stdin = bytes;
  }
  return {
    required: [...required], limits, environment, target, profile,
    entrypoint: { runtime: entrypoint.runtime, path: entrypointPath, mode: entrypoint.mode, bytes: entrypointBytes, sha256: entrypoint.sha256 },
    case: { id: definition.id, argv: [...definition.argv], stdin, fixtures },
  };
}

async function authenticateTarget(target, entrypoint) {
  let resolved;
  try {
    resolved = await fetchExactRepository(target.repository, target.commit, 'mdlm-controlled-target-auth-');
    if (resolved.tree !== target.tree) fail('setup', 'UNAUTHENTICATED_IDENTITY', 'resolved target tree does not match its pin');
    for (const [assetPath, entry] of resolved.entries) requireRegularBlob(entry, `Git tree path ${assetPath}`);
    const entry = requireRegularBlob(resolved.entries.get(target.entrypoint.path), 'controlled target entrypoint');
    const bytes = await readBlob(resolved, entry.object);
    const authenticated = {
      repository: target.repository,
      commit: resolved.commit,
      tree: resolved.tree,
      entrypoint: {
        path: target.entrypoint.path,
        runtime: target.entrypoint.runtime,
        gitMode: entry.mode,
        gitBlob: gitBlobId(bytes),
        sha256: sha256(bytes),
      },
    };
    if (entry.object !== authenticated.entrypoint.gitBlob || entry.mode !== target.entrypoint.gitMode ||
        entry.object !== target.entrypoint.gitBlob || authenticated.entrypoint.sha256 !== target.entrypoint.sha256 ||
        !bytes.equals(entrypoint.bytes)) {
      fail('setup', 'UNAUTHENTICATED_IDENTITY', 'target pins do not match the exact opened Git blob bytes and mode');
    }
    return authenticated;
  } catch (error) {
    if (error instanceof ControlledCaseError) throw error;
    fail('setup', 'UNAUTHENTICATED_IDENTITY', `target identity authentication failed: ${error.message}`);
  } finally {
    if (resolved?.workspace) await rm(resolved.workspace, { recursive: true, force: true });
  }
}

async function readBoundedDescriptor(handle, maximum, label) {
  const before = await handle.stat();
  if (!before.isFile()) throw new Error(`${label} descriptor is no longer a regular file`);
  if (before.size > maximum) throw new Error(`${label} grew beyond its authenticated bound`);
  const bytes = Buffer.allocUnsafe(maximum + 1);
  let length = 0;
  while (length < bytes.length) {
    const { bytesRead } = await handle.read(bytes, length, bytes.length - length, length);
    if (bytesRead === 0) break;
    length += bytesRead;
  }
  if (length > maximum) throw new Error(`${label} grew beyond its authenticated bound`);
  const after = await handle.stat();
  if (!after.isFile() || after.size !== length || after.dev !== before.dev || after.ino !== before.ino) {
    throw new Error(`${label} changed while its retained descriptor was observed`);
  }
  return {
    bytes: bytes.subarray(0, length),
    stat: after,
    metadata: {
      path: label,
      mode: (after.mode & 0o777).toString(8).padStart(4, '0'),
      size: length,
      sha256: digest(bytes.subarray(0, length)),
    },
  };
}

async function verifyRetainedPath(root, relativePath, retainedStat) {
  const parts = relativePath.split('/');
  let current = root;
  for (let index = 0; index < parts.length; index += 1) {
    current = path.join(current, parts[index]);
    const metadata = await lstat(current);
    if (metadata.isSymbolicLink()) throw new Error(`${relativePath} was replaced by a symlink`);
    if (index < parts.length - 1 && !metadata.isDirectory()) throw new Error(`${relativePath} has a replaced parent`);
    if (index === parts.length - 1 && (!metadata.isFile() || metadata.dev !== retainedStat.dev || metadata.ino !== retainedStat.ino)) {
      throw new Error(`${relativePath} no longer names the retained regular file`);
    }
  }
}

function sameMetadata(actual, expected) {
  return actual.path === expected.path && actual.mode === expected.mode && actual.size === expected.size && actual.sha256 === expected.sha256;
}

function initialObservation() {
  return {
    executable: null, argv: [], status: null, signal: null, timedOut: false, ready: true,
    readinessError: null, termSent: false, killSent: false, cleanupComplete: true,
    streams: { childClose: false, stdoutEnded: false, stderrEnded: false, complete: false },
    spawnError: null, stdin: null, stdoutTruncated: false, stderrTruncated: false,
    stdoutBase64: '', stderrBase64: '',
  };
}

function initialResult(request) {
  return {
    schemaVersion: 1,
    kind: 'controlled-case-result',
    capabilities: { implemented: [...implementedCapabilities], required: Array.isArray(request?.capabilities?.required) ? [...request.capabilities.required] : [] },
    identities: null,
    complete: false,
    truncated: false,
    environment: { inherited: false, attested: null },
    workspace: { created: false, path: null, cleaned: false },
    setup: { complete: false, entrypoint: null, fixtures: [] },
    execution: { started: false, stdin: null, observation: initialObservation() },
    post: { complete: false, entrypoint: null, fixtures: [] },
    cleanup: { attempted: false, complete: true, error: null },
    errors: [],
  };
}

export async function executeControlledCase(request) {
  const result = initialResult(request);
  const retained = [];
  let workspace;
  let validated;
  try {
    if (typeof process.env.NODE_OPTIONS === 'string' && process.env.NODE_OPTIONS.length > 0) {
      fail('setup', 'UNTRUSTED_AMBIENT_NODE_OPTIONS', 'controlled execution refuses an ambient NODE_OPTIONS value');
    }
    validated = validateRequest(request);
    result.capabilities.required = validated.required;
    result.environment.attested = structuredClone(validated.environment);

    const [targetIdentity, runnerIdentity] = await Promise.all([
      authenticateTarget(validated.target, validated.entrypoint),
      authenticateRunnerIdentity().catch((error) => fail('setup', 'UNAUTHENTICATED_IDENTITY', `runner identity authentication failed: ${error.message}`)),
    ]);
    result.identities = {
      target: targetIdentity,
      runner: runnerIdentity,
      adapter: { id: 'run-exact@2' },
      profile: profileIdentity(validated.profile),
    };

    workspace = await mkdtemp(path.join(tmpdir(), 'mdlm-controlled-case-'));
    result.workspace = { created: true, path: workspace, cleaned: false };

    const materialize = async (definition, maximum) => {
      const absolute = path.join(workspace, definition.path);
      await mkdir(path.dirname(absolute), { recursive: true, mode: 0o700 });
      await writeFile(absolute, definition.bytes, { flag: 'wx', mode: Number.parseInt(definition.mode, 8) });
      await chmod(absolute, Number.parseInt(definition.mode, 8));
      const handle = await open(absolute, constants.O_RDONLY | constants.O_NOFOLLOW);
      retained.push({ definition, handle, maximum });
      const observed = await readBoundedDescriptor(handle, maximum, definition.path);
      return observed.metadata;
    };

    result.setup.entrypoint = await materialize(validated.entrypoint, validated.entrypoint.bytes.length);
    for (const fixture of validated.case.fixtures) result.setup.fixtures.push(await materialize(fixture, validated.limits.maxFixtureBytes));
    result.setup.complete = true;

    const entrypointPath = path.join(workspace, validated.entrypoint.path);
    const executable = validated.entrypoint.runtime === 'node' ? process.execPath : entrypointPath;
    const argv = validated.entrypoint.runtime === 'node' ? [entrypointPath, ...validated.case.argv] : [...validated.case.argv];
    const environment = {
      ...nodeChildEnvironment(), LANG: validated.environment.LANG, LC_ALL: validated.environment.LC_ALL,
      TZ: validated.environment.TZ, ...validated.environment.variables,
    };
    result.execution.started = true;
    const raw = await runExact(executable, argv, {
      cwd: workspace,
      env: environment,
      deadlineMs: validated.limits.deadlineMs,
      termGraceMs: validated.limits.termGraceMs,
      maxCleanupWaitMs: validated.limits.maxCleanupWaitMs,
      streamDrainMs: validated.limits.streamDrainMs,
      maxOutputBytes: validated.limits.maxOutputBytes,
      ...(validated.case.stdin === undefined ? {} : { stdin: validated.case.stdin }),
    });
    result.execution.stdin = raw.stdin;
    result.execution.observation = serializeObservation(raw);
    result.truncated = raw.stdoutTruncated || raw.stderrTruncated;

    if (raw.stdin && !raw.stdin.complete) result.errors.push(typedError(new ControlledCaseError('execution', 'STDIN_WRITE_INCOMPLETE', 'target did not accept every stdin byte and deterministic EOF', raw.stdin.error)));
    if (raw.timedOut) result.errors.push(typedError(new ControlledCaseError('execution', 'PROCESS_TIMEOUT', 'target exceeded the controlled execution deadline')));
    if (!raw.cleanupComplete) result.errors.push(typedError(new ControlledCaseError('execution', 'PROCESS_CLEANUP_FAILED', 'target process cleanup did not complete within its evidence bound')));
    if (!raw.streams.complete) result.errors.push(typedError(new ControlledCaseError('execution', 'STREAM_OBSERVATION_INCOMPLETE', 'child close and both stream ends were not observed')));
    if (raw.spawnError) result.errors.push(typedError(new ControlledCaseError('execution', 'PROCESS_SPAWN_FAILED', 'target process could not be started', raw.spawnError)));
    if (result.truncated) result.errors.push(typedError(new ControlledCaseError('execution', 'OBSERVATION_TRUNCATED', 'target output exceeded the observation bound')));

    try {
      let aggregatePostBytes = 0;
      for (let index = 0; index < retained.length; index += 1) {
        const item = retained[index];
        const observed = await readBoundedDescriptor(item.handle, item.maximum, item.definition.path);
        await verifyRetainedPath(workspace, item.definition.path, observed.stat);
        if (index === 0) {
          result.post.entrypoint = observed.metadata;
        } else {
          aggregatePostBytes += observed.metadata.size;
          if (aggregatePostBytes > validated.limits.maxAggregateFixtureBytes) throw new Error('fixtures grew beyond maxAggregateFixtureBytes');
          result.post.fixtures.push(observed.metadata);
        }
      }
      result.post.complete = true;
      if (!sameMetadata(result.post.entrypoint, result.setup.entrypoint)) {
        result.errors.push(typedError(new ControlledCaseError('post', 'ENTRYPOINT_CHANGED', 'entrypoint metadata or bytes changed during execution')));
      }
      for (let index = 0; index < result.setup.fixtures.length; index += 1) {
        if (!sameMetadata(result.post.fixtures[index], result.setup.fixtures[index])) {
          result.errors.push(typedError(new ControlledCaseError('post', 'FIXTURE_CHANGED', `fixture changed during execution: ${result.setup.fixtures[index].path}`, { path: result.setup.fixtures[index].path })));
        }
      }
    } catch (error) {
      result.post.complete = false;
      result.errors.push(typedError(new ControlledCaseError('post', 'POST_OBSERVATION_FAILED', 'race-safe post-execution observation failed', {
        cause: error.code ?? 'POST_OBSERVATION_REJECTED', message: error.message,
      })));
    }
  } catch (error) {
    result.errors.push(typedError(error));
  } finally {
    for (const item of retained) {
      try { await item.handle.close(); } catch (error) {
        result.errors.push(typedError(new ControlledCaseError('cleanup', 'DESCRIPTOR_CLEANUP_FAILED', 'retained fixture descriptor did not close', { message: error.message })));
      }
    }
    if (workspace) {
      result.cleanup.attempted = true;
      try {
        await rm(workspace, { recursive: true, force: true });
        result.cleanup.complete = true;
        result.workspace.cleaned = true;
      } catch (error) {
        result.cleanup.complete = false;
        result.cleanup.error = { code: error.code ?? 'UNKNOWN', message: error.message };
        result.errors.push(typedError(new ControlledCaseError('cleanup', 'WORKSPACE_CLEANUP_FAILED', 'controlled workspace cleanup failed', result.cleanup.error)));
      }
    }
  }

  result.complete = result.setup.complete && result.execution.started && result.post.complete && result.cleanup.complete && !result.truncated && result.errors.length === 0;
  return result;
}
