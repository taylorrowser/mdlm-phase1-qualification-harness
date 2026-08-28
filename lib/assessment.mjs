import { lstat, realpath } from 'node:fs/promises';
import path from 'node:path';
import { requireSafeRelativePath } from './common.mjs';

export function observationUsable(observation) {
  return observation.signal === null && !observation.timedOut && !observation.spawnError &&
    observation.cleanupComplete && observation.streams?.complete === true &&
    !observation.stdoutTruncated && !observation.stderrTruncated;
}

export function expectedMatches(observation, expected) {
  return observationUsable(observation) && observation.status === expected.status &&
    observation.stdoutBase64 === expected.stdoutBase64 && observation.stderrBase64 === expected.stderrBase64;
}

export async function assetResolver(configPath, config) {
  const configuredRoot = path.resolve(path.dirname(configPath), config.assetRoot ?? '.');
  const root = await realpath(configuredRoot);
  return async (relative, label) => {
    requireSafeRelativePath(relative, label);
    const candidate = path.resolve(root, relative);
    if (candidate !== root && !candidate.startsWith(`${root}${path.sep}`)) throw new Error(`${label} escapes the asset root`);
    const metadata = await lstat(candidate);
    if (metadata.isSymbolicLink()) throw new Error(`${label} must not be a symlink`);
    const resolved = await realpath(candidate);
    if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) throw new Error(`${label} escapes the asset root through a symlink`);
    if (!metadata.isFile()) throw new Error(`${label} must be a regular file`);
    return resolved;
  };
}
