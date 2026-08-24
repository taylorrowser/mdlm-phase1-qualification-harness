import { requireSafeRelativePath } from './common.mjs';

const oid = '[a-f0-9]{40}';
const sha256 = '[a-f0-9]{64}';
const environmentPattern = new RegExp(`^git-environment:v1;repository=([^;]+);commit=(${oid});tree=(${oid});manifest=([^;]+);manifest-git-blob=(${oid});manifest-sha256=(${sha256})$`);
const assetPattern = new RegExp(`^asset:v1;role=(runner|configuration|fixture|oracle|probe|profile|manifest);path=([^;]+);git-blob=(${oid});sha256=(${sha256})$`);

function encode(value) {
  return encodeURIComponent(value);
}

function decodeCanonical(value, label) {
  let decoded;
  try {
    decoded = decodeURIComponent(value);
  } catch {
    throw new Error(`${label} is not canonically encoded`);
  }
  if (encode(decoded) !== value) throw new Error(`${label} is not canonically encoded`);
  return decoded;
}

export function formatEnvironmentRef(value) {
  return `git-environment:v1;repository=${encode(value.repository)};commit=${value.commit};tree=${value.tree};manifest=${encode(value.manifestPath)};manifest-git-blob=${value.manifestGitBlob};manifest-sha256=${value.manifestSha256}`;
}

export function parseEnvironmentRef(value) {
  const match = environmentPattern.exec(value ?? '');
  if (!match) throw new Error('ENV reproducibility.environment_ref is not canonical');
  const parsed = {
    repository: decodeCanonical(match[1], 'environment repository'),
    commit: match[2],
    tree: match[3],
    manifestPath: requireSafeRelativePath(decodeCanonical(match[4], 'manifest path'), 'manifest path'),
    manifestGitBlob: match[5],
    manifestSha256: match[6],
  };
  if (formatEnvironmentRef(parsed) !== value) throw new Error('ENV reproducibility.environment_ref is not canonical');
  return parsed;
}

export function formatAssetBinding(value) {
  return `asset:v1;role=${value.role};path=${encode(value.path)};git-blob=${value.gitBlob};sha256=${value.sha256}`;
}

export function parseAssetBinding(value) {
  const match = assetPattern.exec(value ?? '');
  if (!match) throw new Error(`VAI activity binding is not canonical: ${value}`);
  const parsed = {
    role: match[1],
    path: requireSafeRelativePath(decodeCanonical(match[2], 'asset path'), 'asset path'),
    gitBlob: match[3],
    sha256: match[4],
  };
  if (formatAssetBinding(parsed) !== value) throw new Error(`VAI activity binding is not canonical: ${value}`);
  return parsed;
}
