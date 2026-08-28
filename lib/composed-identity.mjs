import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

export const identityPaths = [
  ['runner', 'executable', 'executableSha256'],
  ['tooling', 'manifest', 'manifestSha256'],
  ['tooling', 'lockfile', 'lockfileSha256'],
  ['artifacts', 'manifest', 'manifestSha256'],
  ['artifacts', 'mdlmTarball', 'mdlmTarballSha256'],
  ['artifacts', 'mdlmPiTarball', 'mdlmPiTarballSha256'],
  ['harness', 'qualificationManifest', 'qualificationManifestSha256'],
  ['runtime', 'executable', 'executableSha256'],
];

const sha256Pattern = /^sha256:[a-f0-9]{64}$/;
const gitObjectPattern = /^[a-f0-9]{40}$/;

export function digest(bytes) {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

export function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function validateComposedIdentityShape(identity, errors) {
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
  for (const keys of [['processPackage', 'digest'], ['harness', 'configurationSha256']]) {
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

export async function authenticateFile(file, expected, base, errors, context) {
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

export async function authenticateComposedIdentity(identity, identityPath, errors) {
  if (!validateComposedIdentityShape(identity, errors)) return false;
  const start = errors.length;
  for (const [group, fileKey, digestKey] of identityPaths) {
    await authenticateFile(identity[group][fileKey], identity[group][digestKey], path.dirname(identityPath), errors, `${group}.${fileKey}`);
  }
  return errors.length === start;
}

export function identityTuple(identity) {
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
