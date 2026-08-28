import { chmod, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { fileURLToPath } from 'node:url';
import { assetResolver, expectedMatches, observationUsable } from './assessment.mjs';
import { authenticateComposedIdentity, digest, isObject } from './composed-identity.mjs';
import { executeControlledCase } from './controlled-execution.mjs';
import { authenticateRunnerIdentity, gitBlobId, sha256 } from './execution-identity.mjs';
import { runGit } from './git-objects.mjs';
import { calculatorObservation, temperatureObservation } from './oracles.mjs';
import { nodeChildEnvironment, runExact, serializeObservation } from './process-runner.mjs';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const sha256Pattern = /^sha256:[a-f0-9]{64}$/;
const controlCapability = 'phase1.calculator-temperature-oracle';
const expectedCapabilities = [
  {
    id: 'phase1.exact-role-bindings',
    positiveControlIds: ['P-ROLE-EXACT'],
    negativeControlIds: ['N-ROLE-MISMATCH'],
  },
  {
    id: 'phase1.process-contract-oracle',
    positiveControlIds: ['P-PROCESS-EXACT'],
    negativeControlIds: ['N-PROCESS-MISMATCH'],
  },
  {
    id: 'phase1.fixed-identity-authentication',
    positiveControlIds: ['P-IDENTITY-EXACT'],
    negativeControlIds: ['N-IDENTITY-DIGEST'],
  },
  {
    id: 'phase1.deterministic-cleanup',
    positiveControlIds: ['P-CLEAN-COMPLETION'],
    negativeControlIds: ['N-CLEANUP-FAILURE'],
  },
  {
    id: controlCapability,
    positiveControlIds: ['P-CALCULATOR-CORRECT', 'P-TEMPERATURE-CORRECT'],
    negativeControlIds: ['N-CALCULATOR-WRONG', 'N-TEMPERATURE-WRONG'],
  },
];
const expectedControlIds = expectedCapabilities.flatMap((entry) => [...entry.positiveControlIds, ...entry.negativeControlIds]);
const oracles = { calculator: calculatorObservation, temperature: temperatureObservation };

function emptyResult(identitySha256 = null) {
  return {
    schema: 'mdlm-phase1-capability-controls@1',
    status: 'fail',
    evidenceIdentity: null,
    identitySha256,
    source: null,
    configurationSha256: null,
    runtime: null,
    capabilities: [],
    controls: [],
    errors: [],
  };
}

function rawExpected(value) {
  return {
    status: value.status,
    stdoutBase64: value.stdout.toString('base64'),
    stderrBase64: value.stderr.toString('base64'),
  };
}

function control(id, capabilityId, polarity, identity, identitySha256, stimulus, expected, observed, observation) {
  const pass = isDeepStrictEqual(expected, observed);
  return {
    id, capabilityId, polarity,
    evidenceIdentity: identity.id,
    identitySha256,
    stimulus,
    expected,
    observed,
    observation,
    pass,
    outcome: pass ? 'pass' : 'fail',
  };
}

function validateConfig(config, errors) {
  if (!isObject(config) || config.schema !== 'mdlm-phase1-capability-controls-config@1') {
    errors.push({ reason: 'unsupported-control-configuration' });
    return false;
  }
  if (!isDeepStrictEqual(config.capabilities, expectedCapabilities)) {
    errors.push({ reason: 'control-composition-mismatch' });
  }
  const ids = (config.capabilities ?? []).flatMap((entry) => [
    ...(entry?.positiveControlIds ?? []), ...(entry?.negativeControlIds ?? []),
  ]);
  if (ids.length !== 12 || new Set(ids).size !== 12 ||
      expectedControlIds.some((id) => !ids.includes(id)) || ids.some((id) => !expectedControlIds.includes(id))) {
    errors.push({ reason: 'control-id-set-mismatch' });
  }
  if (!isObject(config.bindings) || !isObject(config.process) || !isObject(config.cleanup) ||
      !Array.isArray(config.products) || config.products.length !== 2 || !isObject(config.limits)) {
    errors.push({ reason: 'incomplete-control-configuration' });
  }
  return errors.length === 0;
}

function decision(accepted, reason) {
  return { decision: accepted ? 'accepted' : 'rejected', reason };
}

async function authenticateSourceTree(runner, manifest, manifestBytes) {
  const mismatches = [];
  if (!runner.checkout.clean) mismatches.push('sourceCheckoutClean');
  const expectedEntries = [
    { path: 'manifest.json', mode: '100644', gitBlob: gitBlobId(manifestBytes) },
    ...(manifest.assets ?? []),
  ];
  for (const expected of expectedEntries) {
    let line = '';
    try {
      line = (await runGit(root, ['ls-tree', runner.checkout.commit, '--', expected.path])).toString('utf8').trim();
    } catch {
      mismatches.push(`sourceTree:${expected.path}`);
      continue;
    }
    const match = /^(\d{6}) blob ([a-f0-9]{40})\t(.+)$/.exec(line);
    if (!match || match[1] !== expected.mode || match[2] !== expected.gitBlob || match[3] !== expected.path) {
      mismatches.push(`sourceTree:${expected.path}`);
    }
  }
  return mismatches;
}

async function roleControls(config, manifest, identity, identitySha256) {
  const exact = isDeepStrictEqual(manifest.bindings?.capabilityControls, config.bindings);
  const mutated = structuredClone(config.bindings);
  mutated.runner = 'bin/one-field-role-mismatch.mjs';
  const mutationAccepted = isDeepStrictEqual(manifest.bindings?.capabilityControls, mutated);
  const capabilityId = 'phase1.exact-role-bindings';
  return [
    control(
      'P-ROLE-EXACT', capabilityId, 'positive', identity, identitySha256,
      { kind: 'exact-role-bindings', bindings: config.bindings },
      decision(true, 'exact-role-bindings'), decision(exact, exact ? 'exact-role-bindings' : 'role-binding-mismatch'),
      { manifestBindings: manifest.bindings?.capabilityControls ?? null, evaluatedBindings: config.bindings },
    ),
    control(
      'N-ROLE-MISMATCH', capabilityId, 'negative', identity, identitySha256,
      { kind: 'one-field-role-mutation', field: 'runner', value: mutated.runner },
      decision(false, 'role-binding-mismatch'),
      decision(mutationAccepted, mutationAccepted ? 'exact-role-bindings' : 'role-binding-mismatch'),
      { manifestBindings: manifest.bindings?.capabilityControls ?? null, evaluatedBindings: mutated },
    ),
  ];
}

async function identityControls(identity, identityPath, identitySha256) {
  const positiveErrors = [];
  const authenticated = await authenticateComposedIdentity(identity, identityPath, positiveErrors);
  const mutated = structuredClone(identity);
  mutated.runner.executableSha256 = `sha256:${'0'.repeat(64)}`;
  const negativeErrors = [];
  const mutationAuthenticated = await authenticateComposedIdentity(mutated, identityPath, negativeErrors);
  const negativeRejectedAsStale = !mutationAuthenticated && negativeErrors.some((error) =>
    error.reason === 'stale-evidence-digest' && error.context === 'runner.executable');
  const capabilityId = 'phase1.fixed-identity-authentication';
  return [
    control(
      'P-IDENTITY-EXACT', capabilityId, 'positive', identity, identitySha256,
      { kind: 'authenticate-exact-composed-identity' },
      decision(true, 'identity-authenticated'),
      decision(authenticated, authenticated ? 'identity-authenticated' : 'identity-rejected'),
      { errors: positiveErrors },
    ),
    control(
      'N-IDENTITY-DIGEST', capabilityId, 'negative', identity, identitySha256,
      { kind: 'one-field-digest-mutation', field: 'runner.executableSha256', value: mutated.runner.executableSha256 },
      decision(false, 'stale-identity-digest'),
      decision(!negativeRejectedAsStale, negativeRejectedAsStale ? 'stale-identity-digest' : 'unexpected-identity-result'),
      { errors: negativeErrors },
    ),
  ];
}

async function processControls(config, resolveAsset, identity, identitySha256) {
  const fixture = await resolveAsset(config.process.fixture, 'process control fixture');
  const defaults = {
    env: nodeChildEnvironment(),
    deadlineMs: config.limits.deadlineMs,
    termGraceMs: config.limits.termGraceMs,
    maxOutputBytes: config.limits.maxOutputBytes,
  };
  const positive = serializeObservation(await runExact(process.execPath, [fixture, ...config.process.positiveArgv], defaults));
  const negative = serializeObservation(await runExact(process.execPath, [fixture, ...config.process.negativeArgv], defaults));
  const expected = config.process.expected;
  const capabilityId = 'phase1.process-contract-oracle';
  return [
    control(
      'P-PROCESS-EXACT', capabilityId, 'positive', identity, identitySha256,
      { kind: 'exact-process-contract', argv: config.process.positiveArgv },
      decision(true, 'process-contract-match'),
      decision(expectedMatches(positive, expected), expectedMatches(positive, expected) ? 'process-contract-match' : 'process-contract-mismatch'),
      { expected, actual: positive },
    ),
    control(
      'N-PROCESS-MISMATCH', capabilityId, 'negative', identity, identitySha256,
      { kind: 'wrong-status-and-stream', argv: config.process.negativeArgv },
      decision(false, 'process-contract-mismatch'),
      decision(expectedMatches(negative, expected) || !observationUsable(negative),
        observationUsable(negative) && !expectedMatches(negative, expected) ? 'process-contract-mismatch' : 'unusable-process-observation'),
      { expected, actual: negative },
    ),
  ];
}

async function controlledRequest(config, resolveAsset, argv) {
  const entrypoint = await resolveAsset(config.cleanup.target, 'cleanup control target');
  const bytes = await readFile(entrypoint);
  const runner = await authenticateRunnerIdentity();
  const commit = runner.checkout.commit;
  const tree = runner.checkout.tree;
  const blob = (await runGit(root, ['rev-parse', `${commit}:${config.cleanup.target}`])).toString('utf8').trim();
  const treeEntry = (await runGit(root, ['ls-tree', commit, '--', config.cleanup.target])).toString('utf8').trim();
  const gitMode = treeEntry.split(/\s+/)[0];
  return {
    schemaVersion: 1,
    capabilities: { required: ['controlled-execution@1', 'execution-profile@1'] },
    target: {
      repository: root,
      commit,
      tree,
      entrypoint: { path: config.cleanup.target, runtime: 'node', gitMode, gitBlob: blob, sha256: sha256(bytes) },
    },
    executionProfile: {
      schemaVersion: 1,
      id: 'phase1-capability-cleanup-control',
      entrypoint: {
        runtime: 'node', path: config.cleanup.target, mode: '0500',
        bytesBase64: bytes.toString('base64'), sha256: sha256(bytes),
      },
      environment: { LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8', TZ: 'UTC', variables: {} },
      limits: {
        deadlineMs: config.limits.deadlineMs,
        termGraceMs: config.limits.termGraceMs,
        maxPathBytes: 256,
        maxFixtureBytes: 1,
        maxAggregateFixtureBytes: 1,
        maxStdinBytes: 1,
        maxOutputBytes: config.limits.maxOutputBytes,
      },
    },
    case: { id: argv[0], argv, fixtures: [] },
  };
}

async function cleanupControls(config, resolveAsset, identity, identitySha256) {
  const positive = await executeControlledCase(await controlledRequest(config, resolveAsset, config.cleanup.positiveArgv));
  const negative = await executeControlledCase(await controlledRequest(config, resolveAsset, config.cleanup.negativeArgv));
  const cleanupError = negative.errors.find((error) => error.code === 'WORKSPACE_CLEANUP_FAILED');
  const rejected = !negative.complete && negative.cleanup.complete === false && cleanupError !== undefined;
  const repair = { attempted: false, complete: true, error: null };
  if (negative.workspace.path && !negative.workspace.cleaned) {
    repair.attempted = true;
    try {
      await chmod(negative.workspace.path, 0o700);
      await rm(negative.workspace.path, { recursive: true, force: true });
    } catch (error) {
      repair.complete = false;
      repair.error = { code: error.code ?? 'UNKNOWN', message: error.message };
    }
  }
  const capabilityId = 'phase1.deterministic-cleanup';
  return [
    control(
      'P-CLEAN-COMPLETION', capabilityId, 'positive', identity, identitySha256,
      { kind: 'controlled-clean-completion', argv: config.cleanup.positiveArgv },
      decision(true, 'workspace-cleaned'),
      decision(positive.complete && positive.workspace.cleaned && positive.cleanup.complete, 'workspace-cleaned'),
      positive,
    ),
    control(
      'N-CLEANUP-FAILURE', capabilityId, 'negative', identity, identitySha256,
      { kind: 'controlled-workspace-cleanup-failure', argv: config.cleanup.negativeArgv },
      decision(false, 'workspace-cleanup-failed'),
      decision(!rejected || !repair.complete, rejected && repair.complete ? 'workspace-cleanup-failed' : 'unexpected-cleanup-result'),
      { controlledCase: negative, repair },
    ),
  ];
}

async function productControls(config, resolveAsset, identity, identitySha256) {
  const controls = [];
  for (const product of config.products) {
    const oracle = oracles[product.oracle];
    if (!oracle) throw new Error(`unknown product oracle: ${product.oracle}`);
    const expected = rawExpected(oracle(product.argv));
    for (const [polarity, fixtureName, controlId] of [
      ['positive', product.fixture, product.positiveControlId],
      ['negative', product.negativeFixture, product.negativeControlId],
    ]) {
      const fixture = await resolveAsset(fixtureName, `${product.id} ${polarity} fixture`);
      const observation = serializeObservation(await runExact(process.execPath, [fixture, ...product.argv], {
        env: nodeChildEnvironment(),
        deadlineMs: config.limits.deadlineMs,
        termGraceMs: config.limits.termGraceMs,
        maxOutputBytes: config.limits.maxOutputBytes,
      }));
      const matches = expectedMatches(observation, expected);
      const usable = observationUsable(observation);
      const accepted = polarity === 'positive' ? matches : matches || !usable;
      const expectedDecision = polarity === 'positive'
        ? decision(true, 'oracle-match')
        : decision(false, 'oracle-mismatch');
      const observedDecision = decision(accepted,
        usable ? (matches ? 'oracle-match' : 'oracle-mismatch') : 'unusable-process-observation');
      controls.push(control(
        controlId, controlCapability, polarity, identity, identitySha256,
        { kind: `${product.id}-${polarity}-oracle-control`, argv: product.argv },
        expectedDecision, observedDecision,
        { oracle: product.oracle, expected, actual: observation },
      ));
    }
  }
  return controls;
}

export async function evaluateCapabilityControls(paths) {
  const result = emptyResult(sha256Pattern.test(paths.identitySha256 ?? '') ? paths.identitySha256 : null);
  try {
    if (!sha256Pattern.test(paths.identitySha256 ?? '')) {
      result.errors.push({ reason: 'invalid-identity-trust-input' });
      return result;
    }
    const identityBytes = await readFile(paths.identity);
    const actualIdentitySha256 = digest(identityBytes);
    if (actualIdentitySha256 !== paths.identitySha256) {
      result.errors.push({ reason: 'identity-digest-mismatch', expected: paths.identitySha256, observed: actualIdentitySha256 });
      return result;
    }
    let identity;
    let config;
    let manifest;
    let manifestBytes;
    const configBytes = await readFile(paths.config);
    try {
      identity = JSON.parse(identityBytes.toString('utf8'));
      config = JSON.parse(configBytes.toString('utf8'));
      manifestBytes = await readFile(path.join(root, 'manifest.json'));
      manifest = JSON.parse(manifestBytes.toString('utf8'));
    } catch (error) {
      result.errors.push({ reason: 'invalid-control-input', detail: error.message });
      return result;
    }
    result.evidenceIdentity = typeof identity?.id === 'string' ? identity.id : null;
    result.configurationSha256 = digest(configBytes);
    if (!validateConfig(config, result.errors)) return result;

    const identityErrors = [];
    if (!await authenticateComposedIdentity(identity, paths.identity, identityErrors)) {
      result.errors.push(...identityErrors);
      return result;
    }
    const runner = await authenticateRunnerIdentity();
    const sourceMismatches = await authenticateSourceTree(runner, manifest, manifestBytes);
    result.source = {
      commit: runner.checkout.commit,
      tree: runner.checkout.tree,
      manifestSha256: `sha256:${runner.manifestSha256}`,
      manifestGitBlob: gitBlobId(manifestBytes),
      clean: runner.checkout.clean,
    };
    result.runtime = {
      executable: runner.executable,
      executableSha256: `sha256:${runner.executableSha256}`,
      nodeVersion: runner.nodeVersion,
    };
    const manifestPath = path.isAbsolute(identity.harness.qualificationManifest)
      ? identity.harness.qualificationManifest
      : path.resolve(path.dirname(paths.identity), identity.harness.qualificationManifest);
    const executingConfigPath = path.join(root, 'config/capability-controls.json');
    const manifestConfig = manifest.assets?.find((asset) => asset.path === 'config/capability-controls.json');
    const qualificationConfig = manifest.assets?.find((asset) => asset.path === 'config/qualification.json');
    const compositionMatches = {
      harnessCommit: identity.harness.commit === runner.checkout.commit,
      harnessTree: identity.harness.tree === runner.checkout.tree,
      harnessManifestPath: manifestPath === runner.manifestPath,
      harnessManifestSha256: identity.harness.qualificationManifestSha256 === `sha256:${runner.manifestSha256}`,
      harnessConfigurationSha256: identity.harness.configurationSha256 === `sha256:${qualificationConfig?.sha256}`,
      executingConfigurationPath: path.resolve(paths.config) === executingConfigPath,
      executingConfigurationManifest: manifestConfig?.sha256 === result.configurationSha256.slice('sha256:'.length),
      runtimeExecutable: identity.runtime.executable === runner.executable,
      runtimeExecutableSha256: identity.runtime.executableSha256 === result.runtime.executableSha256,
      runtimeNodeVersion: identity.runtime.nodeVersion === runner.nodeVersion,
    };
    for (const [field, matches] of Object.entries(compositionMatches)) {
      if (!matches) result.errors.push({ reason: 'composition-binding-mismatch', field });
    }
    for (const field of sourceMismatches) result.errors.push({ reason: 'composition-binding-mismatch', field });
    if (result.errors.length > 0) return result;

    const resolveAsset = await assetResolver(paths.config, config);
    result.capabilities = structuredClone(expectedCapabilities);
    result.controls.push(
      ...await roleControls(config, manifest, identity, paths.identitySha256),
      ...await processControls(config, resolveAsset, identity, paths.identitySha256),
      ...await identityControls(identity, paths.identity, paths.identitySha256),
      ...await cleanupControls(config, resolveAsset, identity, paths.identitySha256),
      ...await productControls(config, resolveAsset, identity, paths.identitySha256),
    );
    const ids = result.controls.map((entry) => entry.id);
    if (result.controls.length !== 12 || new Set(ids).size !== 12 ||
        expectedControlIds.some((id) => !ids.includes(id)) || result.controls.some((entry) => !entry.pass)) {
      result.errors.push({ reason: 'capability-control-failed' });
      return result;
    }
    result.status = 'pass';
    return result;
  } catch (error) {
    result.errors.push({ reason: 'capability-controls-failed', detail: error.message });
    return result;
  }
}
