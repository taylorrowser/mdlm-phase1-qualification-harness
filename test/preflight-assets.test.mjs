import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

const cli = path.resolve('bin/mdlm-phase1-qualify.mjs');
const assetPaths = {
  runner: 'bin/runner.mjs',
  configuration: 'config/qualification.json',
  fixture: 'fixtures/conforming.mjs',
  oracle: 'lib/oracle.mjs',
  probe: 'probes/node24.mjs',
  profile: 'profiles/calculator.json',
};
const bindings = {
  runner: assetPaths.runner,
  configuration: assetPaths.configuration,
  fixtures: [assetPaths.fixture],
  oracles: [assetPaths.oracle],
  probes: [assetPaths.probe],
  profiles: [assetPaths.profile],
};
const roles = { runner: 'runner', configuration: 'configuration', fixture: 'fixture', oracle: 'oracle', probe: 'probe', profile: 'profile' };
const git = (cwd, ...args) => execFileSync('/usr/bin/git', args, { cwd, encoding: 'utf8' }).trim();
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
const encoded = (value) => encodeURIComponent(value);
const assetBinding = (role, asset) => `asset:v1;role=${role};path=${encoded(asset.path)};git-blob=${asset.gitBlob};sha256=${asset.sha256}`;

function makeEnvironment(options = {}) {
  const root = mkdtempSync(path.join(tmpdir(), 'phase1-assets-'));
  git(root, 'init', '-q');
  git(root, 'config', 'user.name', 'Test');
  git(root, 'config', 'user.email', 'test@example.invalid');
  for (const assetPath of Object.values(assetPaths)) mkdirSync(path.dirname(path.join(root, assetPath)), { recursive: true });
  const runnerOutput = options.badSelfCheck
    ? '{"ok":true}\n'
    : `${JSON.stringify({ ok: true, node: process.versions.node, assets: Object.keys(assetPaths).length })}\n`;
  writeFileSync(path.join(root, assetPaths.runner), `if(process.argv[2]!=="self-check")process.exit(2);process.stdout.write(${JSON.stringify(runnerOutput)});\n`);
  chmodSync(path.join(root, assetPaths.runner), 0o755);
  writeFileSync(path.join(root, assetPaths.configuration), `${JSON.stringify({ schemaVersion: 1, bindings })}\n`);
  for (const assetPath of Object.values(assetPaths).filter((value) => ![assetPaths.runner, assetPaths.configuration].includes(value))) {
    writeFileSync(path.join(root, assetPath), '{}\n');
  }
  writeFileSync(path.join(root, '.gitattributes'), 'bin/runner.mjs filter=poison\n');
  if (options.symlink) symlinkSync('profiles/calculator.json', path.join(root, 'escape-link'));

  const assets = Object.entries(assetPaths).map(([name, assetPath]) => {
    const bytes = readFileSync(path.join(root, assetPath));
    return {
      path: assetPath,
      mode: name === 'runner' ? '100755' : '100644',
      gitBlob: git(root, 'hash-object', assetPath),
      sha256: digest(bytes),
    };
  });
  if (options.badAssetDigest) assets[0].sha256 = '0'.repeat(64);
  writeFileSync(path.join(root, 'manifest.json'), `${JSON.stringify({ schemaVersion: 1, bindings, assets })}\n`);
  git(root, 'add', '.');
  git(root, 'commit', '-qm', 'qualification environment');
  if (options.submodule) {
    git(root, 'update-index', '--add', '--cacheinfo', `160000,${'1'.repeat(40)},nested-module`);
    git(root, 'commit', '-qm', 'add hostile gitlink');
  }
  const commit = git(root, 'rev-parse', 'HEAD');
  const tree = git(root, 'rev-parse', 'HEAD^{tree}');
  const manifestBytes = readFileSync(path.join(root, 'manifest.json'));
  const manifest = {
    path: 'manifest.json',
    gitBlob: git(root, 'rev-parse', `${commit}:manifest.json`),
    sha256: digest(manifestBytes),
  };
  const environmentRef = `git-environment:v1;repository=${encoded(root)};commit=${commit};tree=${tree};manifest=manifest.json;manifest-git-blob=${manifest.gitBlob};manifest-sha256=${manifest.sha256}`;
  const configAsset = assets.find(({ path: assetPath }) => assetPath === assetPaths.configuration);
  const activityBindings = [
    ...assets.map((asset) => assetBinding(roles[Object.entries(assetPaths).find(([, value]) => value === asset.path)[0]], asset)),
    assetBinding('manifest', manifest),
  ];
  const envPayload = {
    title: 'Source-independent qualification environment',
    rationale: 'Binds the qualification assets to one immutable Git tree.',
    strategy_revision: 'VSP-N4Z1K7J19T-r00001',
    profile_id: 'calculator-cli-bootstrap',
    capabilities: {
      controllability: ['Run exact argument vectors without a shell.'],
      observability: ['Capture separate bounded raw streams and status.'],
      external_services: [],
      timing: 'Deadlines guard infrastructure execution only.',
    },
    reproducibility: {
      environment_ref: environmentRef,
      configuration_digest: `sha256:${configAsset.sha256}`,
      reconstruction: 'Fetch exact regular-file Git blobs, verify each digest, and materialize only verified bytes.',
    },
  };
  const vaiPayload = {
    title: 'Qualification implementation',
    rationale: 'Uses source-independent fixtures, probes, and an oracle.',
    kind: 'qualification',
    implementation_ref: `git:${commit}`,
    independence_mode: 'environment-capability',
    authoring_input_refs: ['VSP-N4Z1K7J19T-r00001'],
    prohibited_inputs_observed: ['product source code', 'product unit tests', 'private implementation details', 'uncontrolled implementation shortcuts'],
    activity_bindings: activityBindings,
    target_behavior: {
      supported: ['Verify controlled execution and independent discrimination.'],
      intentionally_unsupported: ['Product requirement acceptance.'],
    },
  };
  const response = {
    contract: 'mdlm-assignment-response@1',
    assignment: '00000000-0000-4000-8000-000000000000',
    kind: 'proposal',
    proposal: {
      outputs: [
        { localId: 'environment', name: 'environment', invocation: 0, lifecycleDatum: { type: 'ENV', payload: envPayload, links: [{ type: 'realizes', target: 'VSP-N4Z1K7J19T-r00001' }], body: '# Environment\n' } },
        {
          localId: 'qualificationActivity', name: 'qualification_activity', invocation: 0,
          lifecycleDatum: {
            type: 'VER',
            payload: {
              title: 'Qualify the source-independent environment', rationale: 'Positive and negative controls check environment capabilities.',
              kind: 'qualification', method: 'test', assessment_mode: 'automatic',
              claim: { kind: 'qualification', scope: 'environment-capability', formal_evidence_eligible: false },
              acceptance_criteria: ['Every expected control matches.'], evidence_requirements: ['Retain exact raw observations.'],
              expected_success_activity: 'Run conforming controls.', expected_discrimination_activity: 'Run nonconforming controls.',
            },
            links: [{ type: 'governed-by', target: 'VSP-N4Z1K7J19T-r00001' }, { type: 'qualifies', target: '$proposal.environment.revision_id' }],
            body: '# Activity\n',
          },
        },
        { localId: 'qualificationImplementation', name: 'qualification_implementation', invocation: 0, lifecycleDatum: { type: 'VAI', payload: vaiPayload, links: [{ type: 'realizes', target: '$proposal.qualificationActivity.revision_id' }, { type: 'uses', target: '$proposal.environment.revision_id' }, { type: 'targets', target: '$proposal.environment.revision_id' }], body: '# Implementation\n' } },
      ],
      completionEvidence: {}, loadedSkillRefs: [], authoritySupplies: [], standingDelegations: [],
    },
  };
  const responsePath = path.join(root, 'response.json');
  const envPath = path.join(root, 'env.json');
  const vaiPath = path.join(root, 'vai.json');
  writeFileSync(responsePath, JSON.stringify(response));
  writeFileSync(envPath, JSON.stringify({ type: 'ENV', payload: envPayload }));
  writeFileSync(vaiPath, JSON.stringify({ type: 'VAI', payload: vaiPayload }));
  return { root, response, responsePath, envPath, vaiPath };
}

function invoke(fixture, scratch, args = ['--proposal', fixture.responsePath], extraEnv = {}) {
  return spawnSync(process.execPath, [cli, 'preflight', ...args], {
    encoding: 'utf8', env: { ...process.env, ...extraEnv, TMPDIR: scratch }, timeout: 15_000,
  });
}

function withFixture(options, callback) {
  const fixture = makeEnvironment(options);
  const scratch = mkdtempSync(path.join(tmpdir(), 'phase1-preflight-cleanup-'));
  try { callback(fixture, scratch); }
  finally { rmSync(fixture.root, { recursive: true, force: true }); rmSync(scratch, { recursive: true, force: true }); }
}

test('preflight accepts an actual scenario proposal and materializes verified blobs without ambient filters', () => {
  withFixture({}, (fixture, scratch) => {
    const hostile = path.join(fixture.root, 'hostile.gitconfig');
    writeFileSync(hostile, '[filter "poison"]\n\tsmudge = sh -c "printf poisoned"\n[core]\n\thooksPath = /tmp/hostile-hooks\n');
    const result = invoke(fixture, scratch, undefined, { GIT_CONFIG_GLOBAL: hostile, GIT_TEMPLATE_DIR: '/tmp/hostile-template' });
    assert.equal(result.status, 0, result.stderr);
    const evidence = JSON.parse(result.stdout);
    assert.equal(evidence.ok, true);
    assert.equal(evidence.runtime.executable, process.execPath);
    assert.equal(evidence.selfCheck.value.node, process.versions.node);
    assert.deepEqual(readdirSync(scratch), []);
  });
});

test('preflight also accepts exact schema-compatible ENV and VAI payload documents', () => {
  withFixture({}, (fixture, scratch) => {
    const result = invoke(fixture, scratch, ['--env', fixture.envPath, '--vai', fixture.vaiPath]);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(readdirSync(scratch), []);
  });
});

test('preflight rejects proposal placeholders in payload values and object keys but permits required routing links', () => {
  withFixture({}, (fixture, scratch) => {
    fixture.response.proposal.outputs[2].lifecycleDatum.payload.activity_bindings[0] = '$proposal.runner';
    fixture.response.proposal.outputs[2].lifecycleDatum.payload['$proposal.hidden'] = 'value';
    writeFileSync(fixture.responsePath, JSON.stringify(fixture.response));
    const result = invoke(fixture, scratch);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /unresolved \$proposal/);

    delete fixture.response.proposal.outputs[2].lifecycleDatum.payload['$proposal.hidden'];
    fixture.response.proposal.outputs[2].lifecycleDatum.payload.activity_bindings[0] = fixture.response.proposal.outputs[2].lifecycleDatum.payload.activity_bindings[1];
    fixture.response.proposal.completionEvidence = { hidden: '$proposal.not-a-routing-link' };
    writeFileSync(fixture.responsePath, JSON.stringify(fixture.response));
    const outsideLink = invoke(fixture, scratch);
    assert.equal(outsideLink.status, 1);
    assert.match(outsideLink.stderr, /unresolved \$proposal/);
  });
});

test('preflight rejects digest tampering and an inexact structured self-check', () => {
  withFixture({ badAssetDigest: true }, (fixture, scratch) => {
    const result = invoke(fixture, scratch);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /SHA-256 mismatch/);
  });
  withFixture({ badSelfCheck: true }, (fixture, scratch) => {
    const result = invoke(fixture, scratch);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /self-check output/);
  });
});

test('preflight rejects symlinks and submodules anywhere in the fetched tree', () => {
  withFixture({ symlink: true }, (fixture, scratch) => {
    const result = invoke(fixture, scratch);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /symlink/);
  });
  withFixture({ submodule: true }, (fixture, scratch) => {
    const result = invoke(fixture, scratch);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /submodule/);
  });
});
