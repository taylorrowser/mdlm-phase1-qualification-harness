import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { open, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runGit } from './git-objects.mjs';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const sha256Pattern = /^[0-9a-f]{64}$/;

export function canonicalJson(value) {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`);
    return `{${entries.join(',')}}`;
  }
  throw new TypeError('canonical JSON accepts only finite JSON values');
}

export function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

export function gitBlobId(bytes) {
  return createHash('sha1').update(Buffer.from(`blob ${bytes.length}\0`)).update(bytes).digest('hex');
}

async function readNoFollow(file, limit) {
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const metadata = await handle.stat();
    if (!metadata.isFile() || metadata.size > limit) throw new Error(`identity asset is not a bounded regular file: ${file}`);
    return handle.readFile();
  } finally {
    await handle.close();
  }
}

let runnerIdentityPromise;

export function authenticateRunnerIdentity() {
  runnerIdentityPromise ??= (async () => {
    const manifestBytes = await readNoFollow(path.join(root, 'manifest.json'), 4 * 1024 * 1024);
    const manifest = JSON.parse(manifestBytes.toString('utf8'));
    for (const asset of manifest.assets ?? []) {
      if (typeof asset.path !== 'string' || !sha256Pattern.test(asset.sha256 ?? '')) throw new Error('runner manifest contains an invalid asset identity');
      const bytes = await readNoFollow(path.join(root, asset.path), 16 * 1024 * 1024);
      if (sha256(bytes) !== asset.sha256 || gitBlobId(bytes) !== asset.gitBlob) {
        throw new Error(`runner manifest does not authenticate executing asset: ${asset.path}`);
      }
    }

    let commit = null;
    let tree = null;
    let clean = false;
    try {
      commit = (await runGit(root, ['rev-parse', 'HEAD^{commit}'])).toString('utf8').trim();
      tree = (await runGit(root, ['rev-parse', 'HEAD^{tree}'])).toString('utf8').trim();
      const changed = await runGit(root, ['status', '--porcelain=v1', '--untracked-files=all']);
      clean = changed.length === 0;
    } catch {
      commit = null;
      tree = null;
      clean = false;
    }

    return {
      id: 'mdlm-phase1-qualification-harness',
      manifestSha256: sha256(manifestBytes),
      checkout: { commit, tree, clean },
      executable: process.execPath,
      nodeVersion: process.versions.node,
    };
  })();
  return runnerIdentityPromise;
}

export function profileIdentity(profile) {
  const bytes = Buffer.from(canonicalJson(profile));
  return { id: profile.id, sha256: sha256(bytes), canonicalBytes: bytes.length };
}
