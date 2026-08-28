import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

const root = path.resolve('.');
const command = path.join(root, 'bin/mdlm-phase1-qualify.mjs');
const fixtureRoot = path.join(root, 'test/fixtures/admission');
const capabilities = [
  'phase1.exact-role-bindings',
  'phase1.process-contract-oracle',
  'phase1.fixed-identity-authentication',
  'phase1.deterministic-cleanup',
  'phase1.calculator-temperature-oracle',
];

function sha256(file) {
  return `sha256:${createHash('sha256').update(readFileSync(file)).digest('hex')}`;
}

function control(id, evidenceIdentity) {
  return {
    id,
    evidenceId: 'E-CONTROLS',
    evidenceIdentity,
    selector: `$.controls[?(@.id=='${id}')]`,
    expected: id.startsWith('P-') ? 'accepted' : 'rejected',
    observed: id.startsWith('P-') ? 'accepted' : 'rejected',
    outcome: 'pass',
  };
}

function writeJson(file, value) {
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function makeFixture(product, mutate = () => {}) {
  const temporary = mkdtempSync(path.join(tmpdir(), 'phase1-admission-'));
  const asset = path.join(temporary, 'identity-asset.txt');
  writeFileSync(asset, 'authenticated identity asset\n');
  const assetDigest = sha256(asset);
  const identityId = '1111111111111111111111111111111111111111-2222222222222222222222222222222222222222-3333333333333333333333333333333333333333';
  const identity = {
    schemaVersion: 2,
    id: identityId,
    mdlm: { commit: '1'.repeat(40), tree: '4'.repeat(40) },
    runner: { commit: '2'.repeat(40), tree: '5'.repeat(40), executable: asset, executableSha256: assetDigest },
    processPackage: { name: 'mdlm-bootstrap', version: '1.0.0', digest: `sha256:${'6'.repeat(64)}` },
    tooling: { manifest: asset, manifestSha256: assetDigest, lockfile: asset, lockfileSha256: assetDigest },
    artifacts: {
      manifest: asset, manifestSha256: assetDigest,
      mdlmTarball: asset, mdlmTarballSha256: assetDigest,
      mdlmPiTarball: asset, mdlmPiTarballSha256: assetDigest,
    },
    harness: {
      commit: '3'.repeat(40), tree: '7'.repeat(40),
      qualificationManifest: asset, qualificationManifestSha256: assetDigest,
      configurationSha256: `sha256:${'8'.repeat(64)}`,
    },
    runtime: { executable: asset, executableSha256: assetDigest, nodeVersion: process.versions.node },
  };
  const evidenceSource = path.join(fixtureRoot, 'controls.json');
  const evidence = path.join(temporary, 'controls.json');
  writeFileSync(evidence, readFileSync(evidenceSource));
  const controlsByCapability = {
    'phase1.exact-role-bindings': [['P-ROLE-EXACT'], ['N-ROLE-MISMATCH']],
    'phase1.process-contract-oracle': [['P-PROCESS-EXACT'], ['N-PROCESS-MISMATCH']],
    'phase1.fixed-identity-authentication': [['P-IDENTITY-EXACT'], ['N-IDENTITY-DIGEST']],
    'phase1.deterministic-cleanup': [['P-CLEAN-COMPLETION'], ['N-CLEANUP-FAILURE']],
    'phase1.calculator-temperature-oracle': [
      ['P-CALCULATOR-CORRECT', 'P-TEMPERATURE-CORRECT'],
      ['N-CALCULATOR-WRONG', 'N-TEMPERATURE-WRONG'],
    ],
  };
  const inventory = {
    contract: 'mdlm-phase1-capability-inventory@2',
    admissionStatus: 'implemented',
    capabilityVocabulary: [
      ...capabilities,
      'phase1.deterministic-fixture-control', 'phase1.stdin-byte-control',
      'phase1.filesystem-fault-observation', 'phase1.network-denial-observation',
      'phase1.locale-variation-control', 'phase1.repository-state-observation',
    ],
    derivation: {
      alwaysRequired: ['phase1.exact-role-bindings'],
      productProfileInputs: {
        processContract: ['phase1.process-contract-oracle'],
        fixedIdentity: ['phase1.fixed-identity-authentication'],
        cleanupPolicy: ['phase1.deterministic-cleanup'],
        calculatorTemperatureOracle: ['phase1.calculator-temperature-oracle'],
        fixtureClasses: ['phase1.deterministic-fixture-control'],
        stdinBytes: ['phase1.stdin-byte-control'],
        filesystemFaults: ['phase1.filesystem-fault-observation'],
        networkPolicy: ['phase1.network-denial-observation'],
        localeMatrix: ['phase1.locale-variation-control'],
        repositoryObservation: ['phase1.repository-state-observation'],
      },
      envClaimInputs: {
        processOracle: ['phase1.process-contract-oracle'],
        identityAuthenticator: ['phase1.fixed-identity-authentication'],
        cleanupController: ['phase1.deterministic-cleanup'],
        calculatorTemperatureOracle: ['phase1.calculator-temperature-oracle'],
        fixtureController: ['phase1.deterministic-fixture-control'],
        stdinController: ['phase1.stdin-byte-control'],
        filesystemMonitor: ['phase1.filesystem-fault-observation'],
        networkMonitor: ['phase1.network-denial-observation'],
        localeController: ['phase1.locale-variation-control'],
        repositoryObserver: ['phase1.repository-state-observation'],
      },
    },
    applicableIdentities: [JSON.parse(JSON.stringify({ ...identity, schemaVersion: undefined }))],
    evidenceCatalog: [{ id: 'E-CONTROLS', path: evidence, sha256: sha256(evidence) }],
    capabilities: capabilities.map((id) => ({
      id, status: 'qualified', applicableIdentityId: identityId,
      positiveControls: controlsByCapability[id][0].map((controlId) => control(controlId, identityId)),
      negativeControls: controlsByCapability[id][1].map((controlId) => control(controlId, identityId)),
    })),
  };
  const profile = JSON.parse(readFileSync(path.join(fixtureRoot, `${product}-profile.json`), 'utf8'));
  const env = JSON.parse(readFileSync(path.join(fixtureRoot, `${product}-env.json`), 'utf8'));
  const fixture = { temporary, asset, identity, inventory, profile, env, evidence };
  mutate(fixture);
  const paths = {
    profile: path.join(temporary, 'profile.json'),
    env: path.join(temporary, 'env.json'),
    inventory: path.join(temporary, 'inventory.json'),
    identity: path.join(temporary, 'identity.json'),
    output: path.join(temporary, 'result.json'),
  };
  writeJson(paths.profile, fixture.profile);
  writeJson(paths.env, fixture.env);
  writeJson(paths.inventory, fixture.inventory);
  writeJson(paths.identity, fixture.identity);
  return { ...fixture, paths };
}

function invoke(fixture) {
  const result = spawnSync(process.execPath, [
    command, 'admit-env',
    '--profile', fixture.paths.profile,
    '--env', fixture.paths.env,
    '--inventory', fixture.paths.inventory,
    '--identity', fixture.paths.identity,
    '--output', fixture.paths.output,
  ], { encoding: 'utf8' });
  return { process: result, record: JSON.parse(readFileSync(fixture.paths.output, 'utf8')) };
}

for (const product of ['calculator', 'temperature']) {
  test(`${product} canonical Phase 1 ENV is admitted at the public command`, () => {
    const fixture = makeFixture(product);
    try {
      const result = invoke(fixture);
      assert.equal(result.process.status, 0, result.process.stderr);
      assert.equal(result.record.contract, 'mdlm-phase1-env-admission-result@2');
      assert.equal(result.record.status, 'admitted');
      assert.equal(result.record.admissionImplementation, 'implemented');
      assert.deepEqual(result.record.derivedCapabilities, [...capabilities].sort());
      assert.deepEqual(result.record.declaredCapabilities, [...capabilities].sort());
      assert.deepEqual(result.record.qualifiedCapabilities, [...capabilities].sort());
      assert.deepEqual(result.record.omittedCapabilities, []);
      assert.deepEqual(result.record.undeclaredCapabilities, []);
      assert.deepEqual(result.record.unknownInputKeys, []);
      assert.deepEqual(result.record.rejectedCapabilities, []);
      assert.equal(result.record.profileSha256, sha256(fixture.paths.profile));
      assert.equal(result.record.envSha256, sha256(fixture.paths.env));
      assert.equal(result.record.inventorySha256, sha256(fixture.paths.inventory));
      assert.equal(result.record.identitySha256, sha256(fixture.paths.identity));
    } finally {
      rmSync(fixture.temporary, { recursive: true, force: true });
    }
  });
}

const rejectionCases = [
  {
    name: 'omitted required capability', reason: 'omitted-required-capability',
    mutate: ({ env }) => env.requiredCapabilities.pop(),
  },
  {
    name: 'unknown capability ID', reason: 'unknown-capability-id',
    mutate: ({ env }) => env.requiredCapabilities.push('phase1.unknown'),
  },
  {
    name: 'undeclared extra capability', reason: 'undeclared-capability',
    mutate: ({ env }) => env.requiredCapabilities.push('phase1.stdin-byte-control'),
  },
  {
    name: 'unsupported profile input', reason: 'unknown-input-key',
    mutate: ({ profile }) => { profile.capabilityInputs.unsupported = false; },
  },
  {
    name: 'missing profile input', reason: 'missing-profile-input',
    mutate: ({ profile }) => { delete profile.capabilityInputs; },
  },
  {
    name: 'unsupported ENV input', reason: 'unknown-input-key',
    mutate: ({ env }) => { env.capabilityClaims.unsupported = {}; },
  },
  {
    name: 'missing ENV input', reason: 'missing-env-input',
    mutate: ({ env }) => { delete env.capabilityClaims; },
  },
  {
    name: 'duplicate capability ID', reason: 'duplicate-capability-id',
    mutate: ({ env }) => env.requiredCapabilities.push(env.requiredCapabilities[0]),
  },
  {
    name: 'duplicate evidence ID', reason: 'duplicate-evidence-id',
    mutate: ({ inventory }) => inventory.evidenceCatalog.push({ ...inventory.evidenceCatalog[0] }),
  },
  {
    name: 'duplicate control ID', reason: 'duplicate-control-id',
    mutate: ({ inventory }) => {
      inventory.capabilities[1].positiveControls[0].id = inventory.capabilities[0].positiveControls[0].id;
    },
  },
  {
    name: 'identity mismatch', reason: 'identity-mismatch',
    mutate: ({ inventory }) => { inventory.applicableIdentities[0].mdlm.tree = '9'.repeat(40); },
  },
  {
    name: 'stale evidence digest', reason: 'stale-evidence-digest',
    mutate: ({ inventory }) => { inventory.evidenceCatalog[0].sha256 = `sha256:${'0'.repeat(64)}`; },
  },
  {
    name: 'missing positive control', rejectedReason: 'missing-positive-control',
    mutate: ({ inventory }) => { inventory.capabilities[0].positiveControls = []; },
  },
  {
    name: 'missing negative control', rejectedReason: 'missing-negative-control',
    mutate: ({ inventory }) => { inventory.capabilities[0].negativeControls = []; },
  },
  {
    name: 'selector resolving no control', rejectedReason: 'selector-resolves-no-control',
    mutate: ({ inventory }) => { inventory.capabilities[0].positiveControls[0].selector = "$.controls[?(@.id=='absent')]"; },
  },
  {
    name: 'nonqualified capability status', rejectedReason: 'capability-not-qualified',
    mutate: ({ inventory }) => { inventory.capabilities[0].status = 'candidate'; },
  },
  {
    name: 'historical control from another identity', rejectedReason: 'historical-control-identity',
    mutate: ({ inventory }) => { inventory.capabilities[0].positiveControls[0].evidenceIdentity = 'historical'; },
  },
  {
    name: 'empty rule target', reason: 'empty-rule-target',
    mutate: ({ inventory }) => { inventory.derivation.productProfileInputs.processContract = []; },
  },
  {
    name: 'unknown rule target', reason: 'unknown-rule-target',
    mutate: ({ inventory }) => { inventory.derivation.productProfileInputs.processContract = ['phase1.unknown']; },
  },
];

for (const rejectionCase of rejectionCases) {
  test(`admission rejects ${rejectionCase.name} with a complete record`, () => {
    const fixture = makeFixture('calculator', rejectionCase.mutate);
    try {
      const result = invoke(fixture);
      assert.notEqual(result.process.status, 0);
      assert.equal(result.record.contract, 'mdlm-phase1-env-admission-result@2');
      assert.equal(result.record.status, 'rejected');
      assert.ok(Array.isArray(result.record.derivedCapabilities));
      assert.ok(Array.isArray(result.record.declaredCapabilities));
      assert.ok(Array.isArray(result.record.qualifiedCapabilities));
      assert.ok(Array.isArray(result.record.rejectedCapabilities));
      if (rejectionCase.reason) {
        assert.ok(result.record.errors.some(({ reason }) => reason === rejectionCase.reason), JSON.stringify(result.record));
      }
      if (rejectionCase.rejectedReason) {
        assert.ok(result.record.rejectedCapabilities.some(({ reason }) => reason === rejectionCase.rejectedReason), JSON.stringify(result.record));
      }
    } finally {
      rmSync(fixture.temporary, { recursive: true, force: true });
    }
  });
}

test('admission rejects a duplicate derivation rule key in the inventory bytes', () => {
  const fixture = makeFixture('calculator');
  try {
    const inventoryBytes = readFileSync(fixture.paths.inventory, 'utf8').replace(
      '"processContract": [',
      '"processContract": ["phase1.process-contract-oracle"],\n      "processContract": [',
    );
    writeFileSync(fixture.paths.inventory, inventoryBytes);
    const result = invoke(fixture);
    assert.notEqual(result.process.status, 0);
    assert.ok(result.record.errors.some(({ reason, key }) => reason === 'duplicate-json-key' && key.includes('processContract')));
  } finally {
    rmSync(fixture.temporary, { recursive: true, force: true });
  }
});

test('admission rejects identity-bound bytes changed after their digest was declared', () => {
  const fixture = makeFixture('calculator');
  try {
    writeFileSync(fixture.asset, 'changed identity asset\n');
    const result = invoke(fixture);
    assert.notEqual(result.process.status, 0);
    assert.ok(result.record.errors.some(({ reason, context }) => reason === 'stale-evidence-digest' && context === 'runner.executable'));
  } finally {
    rmSync(fixture.temporary, { recursive: true, force: true });
  }
});
