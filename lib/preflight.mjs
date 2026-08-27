import { createHash } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { parseAssetBinding, parseEnvironmentRef } from './bindings.mjs';
import { readJson, rejectProposals, requireSafeRelativePath } from './common.mjs';
import { fetchExactRepository, readBlob, requireRegularBlob } from './git-objects.mjs';
import { nodeChildEnvironment, runExact } from './process-runner.mjs';

const strategyRevision = /^VSP-[0-9A-HJKMNP-TV-Z]{10,12}-r[0-9]{5}$/;
const profileId = /^[a-z][a-z0-9-]*$/;
const sha256Value = /^sha256:[a-f0-9]{64}$/;
const requiredBindingRoles = new Map([
  ['runner', 'runner'],
  ['configuration', 'configuration'],
  ['fixtures', 'fixture'],
  ['oracles', 'oracle'],
  ['probes', 'probe'],
  ['profiles', 'profile'],
]);
const prohibitedInputs = ['product source code', 'product unit tests', 'private implementation details', 'uncontrolled implementation shortcuts'];

function requireObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value;
}

function requireString(value, label) {
  if (typeof value !== 'string' || value.length === 0) throw new Error(`${label} must be a nonempty string`);
}

function requireStringArray(value, label, allowEmpty = false) {
  if (!Array.isArray(value) || (!allowEmpty && value.length === 0) || value.some((entry) => typeof entry !== 'string' || entry.length === 0) || new Set(value).size !== value.length) {
    throw new Error(`${label} must be ${allowEmpty ? 'a' : 'a nonempty'} unique string array`);
  }
}

function rejectProposalKeys(value, location = '$') {
  if (Array.isArray(value)) value.forEach((entry, index) => rejectProposalKeys(entry, `${location}[${index}]`));
  else if (value && typeof value === 'object') {
    for (const [key, entry] of Object.entries(value)) {
      if (key.includes('$proposal')) throw new Error(`unresolved $proposal placeholder in key at ${location}`);
      rejectProposalKeys(entry, `${location}.${key}`);
    }
  }
}

function rejectUnexpectedProposalValues(value, allowedLinks, location = '$', allowValue = false) {
  if (typeof value === 'string') {
    if (value.includes('$proposal') && !allowValue) throw new Error(`unresolved $proposal placeholder at ${location}`);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((entry, index) => rejectUnexpectedProposalValues(entry, allowedLinks, `${location}[${index}]`));
  } else if (value && typeof value === 'object') {
    for (const [key, entry] of Object.entries(value)) {
      rejectUnexpectedProposalValues(entry, allowedLinks, `${location}.${key}`, key === 'target' && allowedLinks.has(value));
    }
  }
}

function outputDatum(output) {
  const datum = output?.lifecycleDatum;
  if (datum?.payload) return datum;
  if (output?.data?.payload) return output.data;
  return null;
}

function validateScenarioLinks(outputs, environment, vai, fullDocument) {
  const environmentOutput = outputs.find((output) => outputDatum(output)?.type === 'ENV');
  const activityOutput = outputs.find((output) => outputDatum(output)?.type === 'VER');
  const vaiOutput = outputs.find((output) => outputDatum(output)?.type === 'VAI');
  if (!environmentOutput || !activityOutput || !vaiOutput || outputs.length !== 3) throw new Error('scenario proposal must contain exactly one ENV, VER, and VAI lifecycleDatum output');
  if (environmentOutput.name !== 'environment' || environmentOutput.localId !== 'environment' || environmentOutput.invocation !== 0 ||
      activityOutput.name !== 'qualification_activity' || activityOutput.localId !== 'qualificationActivity' || activityOutput.invocation !== 0 ||
      vaiOutput.name !== 'qualification_implementation' || vaiOutput.localId !== 'qualificationImplementation' || vaiOutput.invocation !== 0) {
    throw new Error('scenario proposal output routing does not match realize-verification-environment@1');
  }
  const expected = [
    [outputDatum(environmentOutput), [['realizes', environment.strategy_revision]]],
    [outputDatum(activityOutput), [['governed-by', environment.strategy_revision], ['qualifies', '$proposal.environment.revision_id']]],
    [outputDatum(vaiOutput), [['realizes', '$proposal.qualificationActivity.revision_id'], ['uses', '$proposal.environment.revision_id'], ['targets', '$proposal.environment.revision_id']]],
  ];
  const allowedLinks = new Set();
  for (const [datum, links] of expected) {
    if (!isDeepStrictEqual(datum.links?.map(({ type, target }) => [type, target]), links)) {
      throw new Error('scenario proposal links do not match required routing links');
    }
    for (const link of datum.links) allowedLinks.add(link);
  }
  rejectUnexpectedProposalValues(fullDocument, allowedLinks);
  if (outputDatum(activityOutput).payload?.kind !== 'qualification') throw new Error('qualification activity must have kind qualification');
  rejectProposals(environment, '$.ENV.payload');
  rejectProposals(vai, '$.VAI.payload');
}

function extractPayload(document, expectedType) {
  if (document?.type && document.type !== expectedType) throw new Error(`expected ${expectedType} document`);
  return document?.payload ?? document;
}

function extractDocuments(environmentDocument, vaiDocument) {
  const proposal = environmentDocument?.proposal ?? environmentDocument;
  if (Array.isArray(proposal?.outputs)) {
    if (environmentDocument?.proposal && (environmentDocument.contract !== 'mdlm-assignment-response@1' || environmentDocument.kind !== 'proposal')) {
      throw new Error('scenario response contract is invalid');
    }
    rejectProposalKeys(environmentDocument);
    const environment = outputDatum(proposal.outputs.find((output) => outputDatum(output)?.type === 'ENV'))?.payload;
    const vai = outputDatum(proposal.outputs.find((output) => outputDatum(output)?.type === 'VAI'))?.payload;
    if (!environment || !vai) throw new Error('scenario proposal must contain ENV and VAI lifecycleDatum payloads');
    validateScenarioLinks(proposal.outputs, environment, vai, environmentDocument);
    return { environment, vai };
  }
  rejectProposalKeys(environmentDocument);
  rejectProposalKeys(vaiDocument);
  const environment = extractPayload(environmentDocument, 'ENV');
  const vai = extractPayload(vaiDocument, 'VAI');
  rejectProposals(environment, '$.ENV.payload');
  rejectProposals(vai, '$.VAI.payload');
  return { environment, vai };
}

function validateEnvironment(payload) {
  requireObject(payload, 'ENV payload');
  requireString(payload.title, 'ENV title');
  requireString(payload.rationale, 'ENV rationale');
  if (!strategyRevision.test(payload.strategy_revision ?? '')) throw new Error('ENV strategy_revision is invalid');
  if (!profileId.test(payload.profile_id ?? '')) throw new Error('ENV profile_id is invalid');
  const capabilities = requireObject(payload.capabilities, 'ENV capabilities');
  if (!isDeepStrictEqual(Object.keys(capabilities).sort(), ['controllability', 'external_services', 'observability', 'timing'])) throw new Error('ENV capabilities fields are invalid');
  requireStringArray(capabilities.controllability, 'ENV controllability');
  requireStringArray(capabilities.observability, 'ENV observability');
  requireStringArray(capabilities.external_services, 'ENV external_services', true);
  requireString(capabilities.timing, 'ENV timing');
  const reproducibility = requireObject(payload.reproducibility, 'ENV reproducibility');
  if (!isDeepStrictEqual(Object.keys(reproducibility).sort(), ['configuration_digest', 'environment_ref', 'reconstruction'])) throw new Error('ENV reproducibility fields are invalid');
  if (!sha256Value.test(reproducibility.configuration_digest ?? '')) throw new Error('ENV configuration_digest is invalid');
  requireString(reproducibility.reconstruction, 'ENV reconstruction');
  return parseEnvironmentRef(reproducibility.environment_ref);
}

function validateVai(payload, environment, environmentBinding) {
  requireObject(payload, 'VAI payload');
  requireString(payload.title, 'VAI title');
  requireString(payload.rationale, 'VAI rationale');
  if (payload.kind !== 'qualification' || payload.independence_mode !== 'environment-capability') throw new Error('VAI must describe environment-capability qualification');
  if (payload.implementation_ref !== `git:${environmentBinding.commit}`) throw new Error('VAI implementation_ref does not match the environment commit');
  requireStringArray(payload.authoring_input_refs, 'VAI authoring_input_refs');
  if (!isDeepStrictEqual(payload.prohibited_inputs_observed, prohibitedInputs)) throw new Error('VAI prohibited_inputs_observed is invalid');
  requireStringArray(payload.activity_bindings, 'VAI activity_bindings');
  const target = requireObject(payload.target_behavior, 'VAI target_behavior');
  if (!isDeepStrictEqual(Object.keys(target).sort(), ['intentionally_unsupported', 'supported'])) throw new Error('VAI target_behavior fields are invalid');
  requireStringArray(target.supported, 'VAI supported behavior');
  requireStringArray(target.intentionally_unsupported, 'VAI intentionally unsupported behavior');
  if (environment.strategy_revision !== payload.authoring_input_refs[0]) throw new Error('ENV and VAI strategy bindings disagree');
  return payload.activity_bindings.map(parseAssetBinding);
}

function expectedBoundAssets(configuration) {
  const result = [];
  const bindings = requireObject(configuration.bindings, 'configuration bindings');
  for (const [field, role] of requiredBindingRoles) {
    const value = bindings[field];
    if (field === 'runner' || field === 'configuration') {
      result.push({ role, path: requireSafeRelativePath(value, `${field} binding`) });
    } else {
      if (!Array.isArray(value) || value.length === 0) throw new Error(`${field} binding must be a nonempty array`);
      for (const entry of value) result.push({ role, path: requireSafeRelativePath(entry, `${field} binding`) });
    }
  }
  return result;
}

async function materializeVerified(repository, files) {
  const executionRoot = path.join(repository.workspace, 'execution');
  await mkdir(executionRoot, { mode: 0o700 });
  for (const file of files) {
    const destination = path.join(executionRoot, file.path);
    await mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
    await writeFile(destination, file.bytes, { flag: 'wx', mode: file.mode === '100755' ? 0o500 : 0o400 });
    if (!isDeepStrictEqual(await readFile(destination), file.bytes)) throw new Error(`materialized bytes changed: ${file.path}`);
  }
  return executionRoot;
}

export async function preflight(environmentPath, vaiPath) {
  const environmentDocument = await readJson(environmentPath);
  const vaiDocument = vaiPath ? await readJson(vaiPath) : null;
  const { environment, vai } = extractDocuments(environmentDocument, vaiDocument);
  const environmentBinding = validateEnvironment(environment);
  const activityBindings = validateVai(vai, environment, environmentBinding);

  let repository;
  try {
    repository = await fetchExactRepository(environmentBinding.repository, environmentBinding.commit, 'mdlm-phase1-preflight-');
    if (repository.tree !== environmentBinding.tree) throw new Error(`resolved tree ${repository.tree} does not match ENV ${environmentBinding.tree}`);
    for (const [assetPath, entry] of repository.entries) {
      if (assetPath === '.lifecycle' || assetPath.startsWith('.lifecycle/')) throw new Error('.lifecycle/ is forbidden in a qualification environment');
      requireRegularBlob(entry, `Git tree path ${assetPath}`);
    }

    const manifestEntry = requireRegularBlob(repository.entries.get(environmentBinding.manifestPath), 'manifest');
    if (manifestEntry.object !== environmentBinding.manifestGitBlob) throw new Error('manifest Git blob does not match ENV');
    const manifestBytes = await readBlob(repository, manifestEntry.object);
    if (createHash('sha256').update(manifestBytes).digest('hex') !== environmentBinding.manifestSha256) throw new Error('manifest SHA-256 does not match ENV');
    let manifest;
    try { manifest = JSON.parse(manifestBytes.toString('utf8')); } catch (error) { throw new Error(`invalid manifest JSON: ${error.message}`); }
    if (!Array.isArray(manifest.assets)) throw new Error('manifest assets must be an array');

    const verified = [];
    const manifestAssets = new Map();
    for (const asset of manifest.assets) {
      const assetPath = requireSafeRelativePath(asset.path, 'manifest asset path');
      if (manifestAssets.has(assetPath)) throw new Error(`duplicate manifest asset: ${assetPath}`);
      const entry = requireRegularBlob(repository.entries.get(assetPath), `manifest asset ${assetPath}`);
      if (entry.mode !== asset.mode) throw new Error(`file mode mismatch for ${assetPath}`);
      if (entry.object !== asset.gitBlob) throw new Error(`Git blob mismatch for ${assetPath}`);
      const bytes = await readBlob(repository, entry.object);
      const actualSha256 = createHash('sha256').update(bytes).digest('hex');
      if (actualSha256 !== asset.sha256) throw new Error(`SHA-256 mismatch for ${assetPath}`);
      const record = { path: assetPath, mode: entry.mode, gitBlob: entry.object, sha256: actualSha256, bytes };
      manifestAssets.set(assetPath, record);
      verified.push(record);
    }

    const configurationBinding = activityBindings.find(({ role }) => role === 'configuration');
    if (!configurationBinding) throw new Error('VAI has no configuration binding');
    const configurationAsset = manifestAssets.get(configurationBinding.path);
    if (!configurationAsset) throw new Error('bound configuration is absent from the manifest');
    let configuration;
    try { configuration = JSON.parse(configurationAsset.bytes.toString('utf8')); } catch (error) { throw new Error(`invalid configuration JSON: ${error.message}`); }
    if (!isDeepStrictEqual(configuration.bindings, manifest.bindings)) throw new Error('configuration and manifest bindings disagree');
    if (environment.reproducibility.configuration_digest !== `sha256:${configurationAsset.sha256}`) throw new Error('ENV configuration_digest does not match the exact configuration asset');

    const expected = expectedBoundAssets(configuration);
    expected.push({ role: 'manifest', path: environmentBinding.manifestPath });
    if (activityBindings.length !== expected.length) throw new Error('VAI activity bindings do not cover every required asset');
    for (const binding of activityBindings) {
      const expectedBinding = expected.find(({ role, path: assetPath }) => role === binding.role && assetPath === binding.path);
      if (!expectedBinding) throw new Error(`unexpected VAI activity binding: ${binding.role}:${binding.path}`);
      const asset = binding.role === 'manifest'
        ? { gitBlob: manifestEntry.object, sha256: environmentBinding.manifestSha256 }
        : manifestAssets.get(binding.path);
      if (!asset || asset.gitBlob !== binding.gitBlob || asset.sha256 !== binding.sha256) throw new Error(`VAI activity binding does not match exact asset: ${binding.path}`);
    }

    const runnerBinding = activityBindings.find(({ role }) => role === 'runner');
    const runner = manifestAssets.get(runnerBinding?.path);
    if (!runner || runner.mode !== '100755') throw new Error('runner binding must name an executable regular manifest asset');
    verified.push({ path: environmentBinding.manifestPath, mode: manifestEntry.mode, bytes: manifestBytes });
    const executionRoot = await materializeVerified(repository, verified);
    const check = await runExact(process.execPath, [path.join(executionRoot, runner.path), 'self-check'], {
      cwd: executionRoot,
      env: nodeChildEnvironment(),
      deadlineMs: 5_000,
      termGraceMs: 250,
    });
    const expectedSelfCheck = { ok: true, node: process.versions.node, assets: manifest.assets.length };
    const expectedStdout = `${JSON.stringify(expectedSelfCheck)}\n`;
    if (check.status !== 0 || check.signal || check.timedOut || check.spawnError || !check.cleanupComplete ||
        !check.streams.complete || check.stdoutTruncated || check.stderrTruncated || check.stderr.length !== 0 || check.stdout.toString('utf8') !== expectedStdout) {
      throw new Error('self-check output did not match the exact structured contract');
    }
    return {
      ok: true,
      repository: environmentBinding.repository,
      commit: repository.commit,
      tree: repository.tree,
      manifest: { path: environmentBinding.manifestPath, gitBlob: manifestEntry.object, sha256: environmentBinding.manifestSha256 },
      runtime: { executable: process.execPath, nodeVersion: process.versions.node },
      selfCheck: { value: expectedSelfCheck, stdoutBase64: check.stdout.toString('base64'), stderrBase64: '' },
    };
  } finally {
    if (repository?.workspace) await rm(repository.workspace, { recursive: true, force: true });
  }
}
