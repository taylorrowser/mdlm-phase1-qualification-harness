import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

const sha256Pattern = /^sha256:[a-f0-9]{64}$/;
const gitObjectPattern = /^[a-f0-9]{40}$/;
const identityPaths = [
  ['runner', 'executable', 'executableSha256'],
  ['tooling', 'manifest', 'manifestSha256'],
  ['tooling', 'lockfile', 'lockfileSha256'],
  ['artifacts', 'manifest', 'manifestSha256'],
  ['artifacts', 'mdlmTarball', 'mdlmTarballSha256'],
  ['artifacts', 'mdlmPiTarball', 'mdlmPiTarballSha256'],
  ['harness', 'qualificationManifest', 'qualificationManifestSha256'],
  ['runtime', 'executable', 'executableSha256'],
];

function digest(bytes) {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

function sorted(values) {
  return [...new Set(values)].sort();
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function duplicateValues(values) {
  const seen = new Set();
  return values.filter((value) => seen.has(value) || !seen.add(value));
}

function scanDuplicateKeys(text) {
  const duplicates = [];
  let offset = 0;
  const whitespace = () => { while (/\s/.test(text[offset] ?? '')) offset += 1; };
  const string = () => {
    const start = offset++;
    while (offset < text.length) {
      if (text[offset] === '\\') offset += 2;
      else if (text[offset++] === '"') break;
    }
    return JSON.parse(text.slice(start, offset));
  };
  const value = (location) => {
    whitespace();
    if (text[offset] === '{') {
      offset += 1;
      whitespace();
      const keys = new Set();
      while (text[offset] !== '}') {
        const key = string();
        if (keys.has(key)) duplicates.push(`${location}.${key}`);
        keys.add(key);
        whitespace();
        offset += 1;
        value(`${location}.${key}`);
        whitespace();
        if (text[offset] !== ',') break;
        offset += 1;
        whitespace();
      }
      offset += 1;
      return;
    }
    if (text[offset] === '[') {
      offset += 1;
      whitespace();
      let index = 0;
      while (text[offset] !== ']') {
        value(`${location}[${index}]`);
        index += 1;
        whitespace();
        if (text[offset] !== ',') break;
        offset += 1;
        whitespace();
      }
      offset += 1;
      return;
    }
    if (text[offset] === '"') string();
    else while (offset < text.length && !/[\s,}\]]/.test(text[offset])) offset += 1;
  };
  value('$');
  return duplicates;
}

async function loadDocument(file, label, errors) {
  try {
    const bytes = await readFile(file);
    const text = bytes.toString('utf8');
    const value = JSON.parse(text);
    const duplicateKeys = scanDuplicateKeys(text);
    for (const key of duplicateKeys) errors.push({ reason: 'duplicate-json-key', input: label, key });
    return { bytes, value, sha256: digest(bytes) };
  } catch (error) {
    errors.push({ reason: 'invalid-input', input: label, detail: error.message });
    return { bytes: null, value: null, sha256: null };
  }
}

async function authenticateFile(file, expected, base, errors, context) {
  if (typeof file !== 'string' || !sha256Pattern.test(expected ?? '')) {
    errors.push({ reason: 'invalid-digest-binding', context });
    return false;
  }
  const resolved = path.isAbsolute(file) ? file : path.resolve(base, file);
  try {
    const observed = digest(await readFile(resolved));
    if (observed !== expected) {
      errors.push({ reason: 'stale-evidence-digest', context, path: file, expected, observed });
      return false;
    }
    return true;
  } catch (error) {
    errors.push({ reason: 'unresolvable-evidence', context, path: file, detail: error.message });
    return false;
  }
}

function validateIdentityShape(identity, errors) {
  const requiredStrings = [
    ['id'], ['mdlm', 'commit'], ['mdlm', 'tree'], ['runner', 'commit'], ['runner', 'tree'],
    ['processPackage', 'name'], ['processPackage', 'version'], ['processPackage', 'digest'],
    ['harness', 'commit'], ['harness', 'tree'], ['harness', 'configurationSha256'],
    ['runtime', 'nodeVersion'],
  ];
  if (!isObject(identity) || identity.schemaVersion !== 2) {
    errors.push({ reason: 'invalid-composed-identity-schema' });
    return false;
  }
  let valid = true;
  for (const keys of requiredStrings) {
    const value = keys.reduce((entry, key) => entry?.[key], identity);
    if (typeof value !== 'string' || value.length === 0) {
      errors.push({ reason: 'missing-identity-field', field: keys.join('.') });
      valid = false;
    }
  }
  for (const [group, fileKey, digestKey] of identityPaths) {
    if (typeof identity[group]?.[fileKey] !== 'string' || !sha256Pattern.test(identity[group]?.[digestKey] ?? '')) {
      errors.push({ reason: 'missing-identity-field', field: `${group}.${fileKey}/${digestKey}` });
      valid = false;
    }
  }
  for (const keys of [
    ['processPackage', 'digest'], ['harness', 'configurationSha256'],
  ]) {
    if (!sha256Pattern.test(keys.reduce((entry, key) => entry?.[key], identity) ?? '')) {
      errors.push({ reason: 'invalid-identity-digest', field: keys.join('.') });
      valid = false;
    }
  }
  for (const keys of [
    ['mdlm', 'commit'], ['mdlm', 'tree'], ['runner', 'commit'], ['runner', 'tree'],
    ['harness', 'commit'], ['harness', 'tree'],
  ]) {
    if (!gitObjectPattern.test(keys.reduce((entry, key) => entry?.[key], identity) ?? '')) {
      errors.push({ reason: 'invalid-identity-git-object', field: keys.join('.') });
      valid = false;
    }
  }
  return valid;
}

function identityTuple(identity) {
  if (!isObject(identity)) return identity;
  return {
    id: identity.id,
    mdlm: { commit: identity.mdlm?.commit, tree: identity.mdlm?.tree },
    runner: {
      commit: identity.runner?.commit, tree: identity.runner?.tree,
      executable: identity.runner?.executable, executableSha256: identity.runner?.executableSha256,
    },
    processPackage: {
      name: identity.processPackage?.name, version: identity.processPackage?.version,
      digest: identity.processPackage?.digest,
    },
    tooling: {
      manifest: identity.tooling?.manifest, manifestSha256: identity.tooling?.manifestSha256,
      lockfile: identity.tooling?.lockfile, lockfileSha256: identity.tooling?.lockfileSha256,
    },
    artifacts: {
      manifest: identity.artifacts?.manifest, manifestSha256: identity.artifacts?.manifestSha256,
      mdlmTarball: identity.artifacts?.mdlmTarball, mdlmTarballSha256: identity.artifacts?.mdlmTarballSha256,
      mdlmPiTarball: identity.artifacts?.mdlmPiTarball, mdlmPiTarballSha256: identity.artifacts?.mdlmPiTarballSha256,
    },
    harness: {
      commit: identity.harness?.commit, tree: identity.harness?.tree,
      qualificationManifest: identity.harness?.qualificationManifest,
      qualificationManifestSha256: identity.harness?.qualificationManifestSha256,
      configurationSha256: identity.harness?.configurationSha256,
    },
    runtime: {
      executable: identity.runtime?.executable, executableSha256: identity.runtime?.executableSha256,
      nodeVersion: identity.runtime?.nodeVersion,
    },
  };
}

function resolveSelector(document, selector) {
  if (selector === '$') return [document];
  if (typeof selector !== 'string') return [];
  const pointer = selector.match(/^#(\/.*)$/);
  if (pointer) {
    let selected = document;
    for (const part of pointer[1].slice(1).split('/').map((entry) => entry.replaceAll('~1', '/').replaceAll('~0', '~'))) {
      selected = selected?.[part];
    }
    return selected === undefined ? [] : [selected];
  }
  const filtered = selector.match(/^\$\.([A-Za-z_][A-Za-z0-9_-]*)\[\?\(@\.id=='([^']+)'\)\]$/);
  if (filtered && Array.isArray(document?.[filtered[1]])) {
    return document[filtered[1]].filter((entry) => entry?.id === filtered[2]);
  }
  return [];
}

function validateRuleMap(map, vocabulary, location, errors) {
  if (!isObject(map)) {
    errors.push({ reason: 'missing-derivation-map', map: location });
    return;
  }
  for (const [key, targets] of Object.entries(map)) {
    if (!Array.isArray(targets) || targets.length === 0) {
      errors.push({ reason: 'empty-rule-target', rule: `${location}.${key}` });
      continue;
    }
    for (const target of targets) {
      if (!vocabulary.has(target)) errors.push({ reason: 'unknown-rule-target', rule: `${location}.${key}`, id: target });
    }
  }
}

export async function admitEnvironment(paths) {
  const errors = [];
  const [profileDocument, envDocument, inventoryDocument, identityDocument] = await Promise.all([
    loadDocument(paths.profile, 'profile', errors),
    loadDocument(paths.env, 'env', errors),
    loadDocument(paths.inventory, 'inventory', errors),
    loadDocument(paths.identity, 'identity', errors),
  ]);
  const result = {
    contract: 'mdlm-phase1-env-admission-result@2',
    status: 'rejected',
    admissionImplementation: 'implemented',
    profileSha256: profileDocument.sha256,
    envSha256: envDocument.sha256,
    inventorySha256: inventoryDocument.sha256,
    identitySha256: identityDocument.sha256,
    applicableIdentityId: identityDocument.value?.id ?? null,
    derivedCapabilities: [],
    declaredCapabilities: [],
    omittedCapabilities: [],
    undeclaredCapabilities: [],
    unknownInputKeys: [],
    qualifiedCapabilities: [],
    rejectedCapabilities: [],
    errors,
  };
  const profile = profileDocument.value;
  const env = envDocument.value;
  const inventory = inventoryDocument.value;
  const identity = identityDocument.value;
  if (!isObject(profile) || !isObject(env) || !isObject(inventory) || !isObject(identity)) return result;

  if (inventory.contract !== 'mdlm-phase1-capability-inventory@2') errors.push({ reason: 'unsupported-inventory-contract' });
  if (inventory.admissionStatus !== 'implemented') {
    result.admissionImplementation = inventory.admissionStatus === 'not-implemented' ? 'not-implemented' : 'implemented';
    errors.push({ reason: 'admission-not-implemented' });
  }

  const vocabularyValues = Array.isArray(inventory.capabilityVocabulary) ? inventory.capabilityVocabulary : [];
  if (!Array.isArray(inventory.capabilityVocabulary)) errors.push({ reason: 'missing-capability-vocabulary' });
  for (const id of duplicateValues(vocabularyValues)) errors.push({ reason: 'duplicate-capability-id', id, location: 'capabilityVocabulary' });
  const vocabulary = new Set(vocabularyValues);
  const derivation = inventory.derivation;
  if (!isObject(derivation)) errors.push({ reason: 'missing-derivation' });
  const alwaysRequired = Array.isArray(derivation?.alwaysRequired) ? derivation.alwaysRequired : [];
  if (!Array.isArray(derivation?.alwaysRequired)) errors.push({ reason: 'missing-always-required' });
  for (const target of alwaysRequired) {
    if (!vocabulary.has(target)) errors.push({ reason: 'unknown-rule-target', rule: 'alwaysRequired', id: target });
  }
  if (alwaysRequired.length === 0) errors.push({ reason: 'empty-rule-target', rule: 'alwaysRequired' });
  validateRuleMap(derivation?.productProfileInputs, vocabulary, 'productProfileInputs', errors);
  validateRuleMap(derivation?.envClaimInputs, vocabulary, 'envClaimInputs', errors);

  const derived = new Set(alwaysRequired);
  if (!isObject(profile.capabilityInputs)) errors.push({ reason: 'missing-profile-input' });
  else for (const key of Object.keys(profile.capabilityInputs)) {
    const targets = derivation?.productProfileInputs?.[key];
    if (!Array.isArray(targets)) result.unknownInputKeys.push(`productProfileInputs.${key}`);
    else for (const target of targets) derived.add(target);
  }
  if (!isObject(env.capabilityClaims)) errors.push({ reason: 'missing-env-input' });
  else for (const key of Object.keys(env.capabilityClaims)) {
    const targets = derivation?.envClaimInputs?.[key];
    if (!Array.isArray(targets)) result.unknownInputKeys.push(`envClaimInputs.${key}`);
    else for (const target of targets) derived.add(target);
  }
  if (result.unknownInputKeys.length > 0) errors.push({ reason: 'unknown-input-key' });

  const declared = Array.isArray(env.requiredCapabilities) ? env.requiredCapabilities : [];
  if (!Array.isArray(env.requiredCapabilities)) errors.push({ reason: 'missing-required-capabilities' });
  for (const id of duplicateValues(declared)) errors.push({ reason: 'duplicate-capability-id', id, location: 'requiredCapabilities' });
  for (const id of declared) if (!vocabulary.has(id)) errors.push({ reason: 'unknown-capability-id', id });
  result.derivedCapabilities = sorted(derived);
  result.declaredCapabilities = sorted(declared);
  result.omittedCapabilities = result.derivedCapabilities.filter((id) => !declared.includes(id));
  result.undeclaredCapabilities = result.declaredCapabilities.filter((id) => !derived.has(id));
  if (result.omittedCapabilities.length > 0) errors.push({ reason: 'omitted-required-capability' });
  if (result.undeclaredCapabilities.length > 0) errors.push({ reason: 'undeclared-capability' });
  result.unknownInputKeys.sort();

  const identities = Array.isArray(inventory.applicableIdentities) ? inventory.applicableIdentities : [];
  if (!Array.isArray(inventory.applicableIdentities)) errors.push({ reason: 'missing-applicable-identities' });
  for (const id of duplicateValues(identities.map((entry) => entry?.id))) errors.push({ reason: 'duplicate-identity-id', id });
  if (validateIdentityShape(identity, errors)) {
    for (const [group, fileKey, digestKey] of identityPaths) {
      await authenticateFile(identity[group][fileKey], identity[group][digestKey], path.dirname(paths.identity), errors, `${group}.${fileKey}`);
    }
  }
  const matchingIdentities = identities.filter((entry) => entry?.id === identity.id && isDeepStrictEqual(identityTuple(entry), identityTuple(identity)));
  if (matchingIdentities.length !== 1) errors.push({ reason: 'identity-mismatch', id: identity.id });

  const evidenceCatalog = Array.isArray(inventory.evidenceCatalog) ? inventory.evidenceCatalog : [];
  if (!Array.isArray(inventory.evidenceCatalog)) errors.push({ reason: 'missing-evidence-catalog' });
  for (const id of duplicateValues(evidenceCatalog.map((entry) => entry?.id))) errors.push({ reason: 'duplicate-evidence-id', id });
  const evidenceById = new Map();
  for (const evidenceEntry of evidenceCatalog) {
    if (evidenceById.has(evidenceEntry?.id)) continue;
    const valid = await authenticateFile(evidenceEntry?.path, evidenceEntry?.sha256, path.dirname(paths.inventory), errors, `evidence:${evidenceEntry?.id}`);
    let document = null;
    if (valid) {
      try {
        document = JSON.parse(await readFile(path.isAbsolute(evidenceEntry.path) ? evidenceEntry.path : path.resolve(path.dirname(paths.inventory), evidenceEntry.path), 'utf8'));
      } catch (error) {
        errors.push({ reason: 'invalid-evidence-json', evidenceId: evidenceEntry.id, detail: error.message });
      }
    }
    evidenceById.set(evidenceEntry?.id, document);
  }

  const rows = Array.isArray(inventory.capabilities) ? inventory.capabilities : [];
  if (!Array.isArray(inventory.capabilities)) errors.push({ reason: 'missing-capability-rows' });
  for (const id of duplicateValues(rows.map((entry) => entry?.id))) errors.push({ reason: 'duplicate-capability-id', id, location: 'capabilities' });
  const statuses = new Set(['gap', 'candidate', 'observed-not-qualified', 'qualified', 'unassessed']);
  for (const row of rows) {
    if (!vocabulary.has(row?.id)) errors.push({ reason: 'unknown-capability-row', id: row?.id });
    if (!statuses.has(row?.status)) errors.push({ reason: 'invalid-capability-status', id: row?.id, status: row?.status });
  }
  const controlIds = new Set();
  for (const row of rows) for (const controlEntry of [
    ...(Array.isArray(row?.positiveControls) ? row.positiveControls : []),
    ...(Array.isArray(row?.negativeControls) ? row.negativeControls : []),
  ]) {
    if (controlIds.has(controlEntry?.id)) errors.push({ reason: 'duplicate-control-id', id: controlEntry?.id });
    controlIds.add(controlEntry?.id);
  }

  for (const id of result.derivedCapabilities) {
    const matchingRows = rows.filter((row) => row?.id === id);
    const rejection = { id, reason: null, evidenceIds: [] };
    if (matchingRows.length !== 1) rejection.reason = 'capability-row-count';
    else {
      const row = matchingRows[0];
      const positives = Array.isArray(row.positiveControls) ? row.positiveControls : [];
      const negatives = Array.isArray(row.negativeControls) ? row.negativeControls : [];
      if (row.status !== 'qualified') rejection.reason = 'capability-not-qualified';
      else if (row.applicableIdentityId !== identity.id || matchingIdentities.length !== 1) rejection.reason = 'capability-identity-mismatch';
      else if (positives.length === 0) rejection.reason = 'missing-positive-control';
      else if (negatives.length === 0) rejection.reason = 'missing-negative-control';
      else {
        for (const controlEntry of [...positives, ...negatives]) {
          rejection.evidenceIds.push(controlEntry?.evidenceId);
          const evidenceDocument = evidenceById.get(controlEntry?.evidenceId);
          if (!evidenceById.has(controlEntry?.evidenceId)) rejection.reason ??= 'unknown-control-evidence';
          else if (controlEntry?.evidenceIdentity !== identity.id) rejection.reason ??= 'historical-control-identity';
          else if (controlEntry?.outcome !== 'pass' || !Object.hasOwn(controlEntry ?? {}, 'expected') || !Object.hasOwn(controlEntry ?? {}, 'observed') || !isDeepStrictEqual(controlEntry.expected, controlEntry.observed)) rejection.reason ??= 'control-not-passing';
          else {
            const selected = resolveSelector(evidenceDocument, controlEntry?.selector);
            if (selected.length !== 1 || selected[0]?.id !== controlEntry.id) rejection.reason ??= 'selector-resolves-no-control';
            else if (
              !isDeepStrictEqual(selected[0].expected, controlEntry.expected)
              || !isDeepStrictEqual(selected[0].observed, controlEntry.observed)
              || selected[0].outcome !== controlEntry.outcome
            ) rejection.reason ??= 'evidence-control-mismatch';
          }
        }
      }
    }
    rejection.evidenceIds = sorted(rejection.evidenceIds.filter(Boolean));
    if (rejection.reason) result.rejectedCapabilities.push(rejection);
    else result.qualifiedCapabilities.push(id);
  }
  result.qualifiedCapabilities.sort();
  if (result.rejectedCapabilities.length > 0) errors.push({ reason: 'capability-qualification-failed' });
  if (errors.length === 0) result.status = 'admitted';
  return result;
}
