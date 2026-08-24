import { createHash } from 'node:crypto';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { formatAssetBinding, formatEnvironmentRef } from '../lib/bindings.mjs';
import { parseOptions, readJson, requireSafeRelativePath } from '../lib/common.mjs';
import { fetchExactRepository, readBlob, requireRegularBlob } from '../lib/git-objects.mjs';

const options = parseOptions(process.argv.slice(2), ['--repository', '--commit', '--assignment', '--strategy', '--output']);
const repositoryLocator = options['--repository'];
const commit = options['--commit'];
const assignment = options['--assignment'];
const output = path.resolve(options['--output']);
const strategyDocument = await readJson(options['--strategy']);
const strategy = strategyDocument.data ?? strategyDocument;
const strategyRevision = strategy.revision_id ?? strategy.identity?.revision_id;
const profile = strategy.payload?.environment_profile;
if (strategy.type !== 'VSP' || !/^VSP-[0-9A-HJKMNP-TV-Z]{10,12}-r[0-9]{5}$/.test(strategyRevision ?? '') || !profile?.id || !profile.capabilities) {
  throw new Error('--strategy must name one exact VSP revision with an environment_profile');
}

const roleByPath = new Map();
function addRole(role, value) {
  const paths = Array.isArray(value) ? value : [value];
  if (paths.length === 0) throw new Error(`${role} binding must not be empty`);
  for (const assetPath of paths) {
    requireSafeRelativePath(assetPath, `${role} binding`);
    if (roleByPath.has(assetPath)) throw new Error(`asset has multiple binding roles: ${assetPath}`);
    roleByPath.set(assetPath, role);
  }
}

let resolved;
try {
  resolved = await fetchExactRepository(repositoryLocator, commit, 'mdlm-phase1-generate-');
  for (const [assetPath, entry] of resolved.entries) {
    if (assetPath === '.lifecycle' || assetPath.startsWith('.lifecycle/')) throw new Error('.lifecycle/ is forbidden in a qualification environment');
    requireRegularBlob(entry, `Git tree path ${assetPath}`);
  }
  const manifestPath = 'manifest.json';
  const manifestEntry = requireRegularBlob(resolved.entries.get(manifestPath), 'manifest');
  const manifestBytes = await readBlob(resolved, manifestEntry.object);
  const manifestSha256 = createHash('sha256').update(manifestBytes).digest('hex');
  let manifest;
  try { manifest = JSON.parse(manifestBytes.toString('utf8')); } catch (error) { throw new Error(`invalid manifest JSON: ${error.message}`); }
  if (!Array.isArray(manifest.assets) || !manifest.bindings) throw new Error('manifest is missing assets or bindings');
  addRole('runner', manifest.bindings.runner);
  addRole('configuration', manifest.bindings.configuration);
  addRole('fixture', manifest.bindings.fixtures);
  addRole('oracle', manifest.bindings.oracles);
  addRole('probe', manifest.bindings.probes);
  addRole('profile', manifest.bindings.profiles);

  const verifiedAssets = new Map();
  for (const asset of manifest.assets) {
    const assetPath = requireSafeRelativePath(asset.path, 'manifest asset path');
    const entry = requireRegularBlob(resolved.entries.get(assetPath), `manifest asset ${assetPath}`);
    if (entry.object !== asset.gitBlob || entry.mode !== asset.mode) throw new Error(`manifest object mismatch for ${assetPath}`);
    const bytes = await readBlob(resolved, entry.object);
    const rawSha256 = createHash('sha256').update(bytes).digest('hex');
    if (rawSha256 !== asset.sha256) throw new Error(`manifest SHA-256 mismatch for ${assetPath}`);
    verifiedAssets.set(assetPath, { path: assetPath, gitBlob: entry.object, sha256: rawSha256, bytes });
  }
  const assetBindings = [];
  for (const [assetPath, role] of roleByPath) {
    const asset = verifiedAssets.get(assetPath);
    if (!asset) throw new Error(`bound asset is absent from manifest: ${assetPath}`);
    assetBindings.push(formatAssetBinding({ role, ...asset }));
  }
  assetBindings.push(formatAssetBinding({ role: 'manifest', path: manifestPath, gitBlob: manifestEntry.object, sha256: manifestSha256 }));
  const configuration = verifiedAssets.get(manifest.bindings.configuration);
  if (!configuration) throw new Error('configuration binding is absent from manifest');
  let configurationValue;
  try { configurationValue = JSON.parse(configuration.bytes.toString('utf8')); } catch (error) { throw new Error(`invalid configuration JSON: ${error.message}`); }
  if (!isDeepStrictEqual(configurationValue.bindings, manifest.bindings)) throw new Error('configuration and manifest bindings disagree');

  const environmentRef = formatEnvironmentRef({
    repository: repositoryLocator,
    commit: resolved.commit,
    tree: resolved.tree,
    manifestPath,
    manifestGitBlob: manifestEntry.object,
    manifestSha256,
  });
  const environmentPayload = {
    title: `${profile.id} source-independent qualification environment`,
    rationale: 'The exact Git tree binds the runner, configuration, fixtures, probes, oracle, profiles, and manifest used for qualification.',
    strategy_revision: strategyRevision,
    profile_id: profile.id,
    capabilities: profile.capabilities,
    reproducibility: {
      environment_ref: environmentRef,
      configuration_digest: `sha256:${configuration.sha256}`,
      reconstruction: 'Fetch the exact commit into an isolated bare object store. Reject non-regular tree entries. Verify each bound Git blob and raw SHA-256 before materializing and executing only those bytes with the current trusted Node runtime.',
    },
  };
  const activityPayload = {
    title: `${profile.id} environment qualification activity`,
    rationale: 'Positive controls establish the declared execution capabilities, and negative controls establish discrimination without product evidence.',
    kind: 'qualification',
    method: 'test',
    assessment_mode: 'automatic',
    claim: { kind: 'qualification', scope: 'environment-capability', formal_evidence_eligible: false },
    acceptance_criteria: ['Every declared capability probe and conforming fixture matches its exact expected observation.', 'Every deliberately nonconforming fixture is distinguished from the independent oracle.'],
    evidence_requirements: ['Record exact commit, tree, manifest, asset bindings, runtime, statuses, cleanup result, and bounded raw stdout and stderr observations.'],
    expected_success_activity: 'Run the immutable probes and conforming fixtures through the bound runner and compare exact observations with the independent oracle.',
    expected_discrimination_activity: 'Run deliberately nonconforming fixtures and require every result to differ from the independent oracle expectation.',
  };
  const vaiPayload = {
    title: `${profile.id} qualification implementation`,
    rationale: 'The implementation uses only the exact source-independent assets bound to the immutable qualification tree.',
    kind: 'qualification',
    implementation_ref: `git:${resolved.commit}`,
    independence_mode: 'environment-capability',
    authoring_input_refs: [strategyRevision],
    prohibited_inputs_observed: ['product source code', 'product unit tests', 'private implementation details', 'uncontrolled implementation shortcuts'],
    activity_bindings: assetBindings,
    target_behavior: {
      supported: ['Verify the exact environment objects, execute positive capability checks, preserve bounded raw observations, and distinguish deliberately nonconforming controls.'],
      intentionally_unsupported: ['Product requirement acceptance, product-conformance verdicts, formal product evidence, and use of product source or product unit tests.'],
    },
  };
  const response = {
    contract: 'mdlm-assignment-response@1',
    assignment,
    kind: 'proposal',
    proposal: {
      outputs: [
        {
          localId: 'environment', name: 'environment', invocation: 0,
          lifecycleDatum: {
            type: 'ENV', payload: environmentPayload,
            links: [{ type: 'realizes', target: strategyRevision }],
            body: `# ${environmentPayload.title}\n\n${environmentPayload.rationale}\n`,
          },
        },
        {
          localId: 'qualificationActivity', name: 'qualification_activity', invocation: 0,
          lifecycleDatum: {
            type: 'VER', payload: activityPayload,
            links: [{ type: 'governed-by', target: strategyRevision }, { type: 'qualifies', target: '$proposal.environment.revision_id' }],
            body: `# ${activityPayload.title}\n\n${activityPayload.rationale}\n`,
          },
        },
        {
          localId: 'qualificationImplementation', name: 'qualification_implementation', invocation: 0,
          lifecycleDatum: {
            type: 'VAI', payload: vaiPayload,
            links: [{ type: 'realizes', target: '$proposal.qualificationActivity.revision_id' }, { type: 'uses', target: '$proposal.environment.revision_id' }, { type: 'targets', target: '$proposal.environment.revision_id' }],
            body: `# ${vaiPayload.title}\n\n${vaiPayload.rationale}\n`,
          },
        },
      ],
      completionEvidence: { preflightRequiredBeforeSubmission: true },
      loadedSkillRefs: ['skills/lifecycle-data.md@1', 'skills/verification-environments.md@1', 'skills/qualification-verification.md@1', 'skills/reproducibility.md@1', 'skills/author-preflight.md@2'],
      authoritySupplies: [],
      standingDelegations: [],
    },
  };
  await mkdir(path.dirname(output), { recursive: true });
  await writeFile(output, `${JSON.stringify(response, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
} finally {
  if (resolved?.workspace) await rm(resolved.workspace, { recursive: true, force: true });
}
