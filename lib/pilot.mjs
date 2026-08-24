import { createHash } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { readJson, rejectProposals, requireSafeRelativePath } from './common.mjs';
import { fetchExactRepository, readBlob, requireRegularBlob } from './git-objects.mjs';
import { nodeChildEnvironment, runExact, serializeObservation } from './process-runner.mjs';

const oid = /^[0-9a-f]{40}$/;
const sha256Pattern = /^[0-9a-f]{64}$/;

function matches(observation, expected) {
  return observation.status === expected.status && observation.signal === null &&
    !observation.timedOut && !observation.spawnError && observation.cleanupComplete &&
    !observation.stdoutTruncated && !observation.stderrTruncated &&
    observation.stdoutBase64 === expected.stdoutBase64 && observation.stderrBase64 === expected.stderrBase64;
}

function validateLiteralProfile(profile) {
  rejectProposals(profile);
  if (!oid.test(profile.commit ?? '') || !oid.test(profile.tree ?? '')) throw new Error('profile must declare exact commit and tree IDs');
  if (!profile.entrypoint || profile.entrypoint.runtime !== 'node' || typeof profile.entrypoint.path !== 'string') {
    throw new Error('profile entrypoint must declare the trusted node runtime and path');
  }
  requireSafeRelativePath(profile.entrypoint.path, 'public entrypoint');
  if (!oid.test(profile.entrypoint.gitBlob ?? '') || !sha256Pattern.test(profile.entrypoint.sha256 ?? '')) {
    throw new Error('profile entrypoint must declare exact Git blob and raw SHA-256 digests');
  }
  if (!Array.isArray(profile.cases) || profile.cases.length === 0) throw new Error('profile must contain cases');
  for (const definition of profile.cases) {
    if (!Array.isArray(definition.argv) || definition.argv.some((value) => typeof value !== 'string')) throw new Error(`case ${definition.id} argv must be literal strings`);
    const expected = definition.expected;
    if (!expected || !Number.isInteger(expected.status) || typeof expected.stdoutBase64 !== 'string' || typeof expected.stderrBase64 !== 'string') {
      throw new Error(`case ${definition.id} must declare exact raw observations`);
    }
    for (const field of ['stdoutBase64', 'stderrBase64']) {
      if (Buffer.from(expected[field], 'base64').toString('base64') !== expected[field]) throw new Error(`case ${definition.id} has non-canonical ${field}`);
    }
  }
}

export async function pilot(profilePath, repository, commit) {
  const profile = await readJson(profilePath);
  validateLiteralProfile(profile);
  if (repository !== profile.repository) throw new Error('repository does not match the authoritative profile');
  if (commit !== profile.commit) throw new Error('commit does not match the authoritative profile');

  let resolved;
  try {
    resolved = await fetchExactRepository(repository, commit, 'mdlm-phase1-pilot-');
    if (resolved.tree !== profile.tree) throw new Error(`resolved tree mismatch: ${resolved.tree}`);
    for (const [assetPath, entry] of resolved.entries) requireRegularBlob(entry, `Git tree path ${assetPath}`);

    const entry = requireRegularBlob(resolved.entries.get(profile.entrypoint.path), 'public entrypoint');
    if (entry.object !== profile.entrypoint.gitBlob) throw new Error('public entrypoint Git blob does not match the profile');
    const bytes = await readBlob(resolved, entry.object);
    const digest = createHash('sha256').update(bytes).digest('hex');
    if (digest !== profile.entrypoint.sha256) throw new Error('public entrypoint SHA-256 does not match the profile');

    const executionRoot = path.join(resolved.workspace, 'execution');
    const executablePath = path.join(executionRoot, profile.entrypoint.path);
    await mkdir(path.dirname(executablePath), { recursive: true, mode: 0o700 });
    await writeFile(executablePath, bytes, { flag: 'wx', mode: 0o500 });
    if (!Buffer.from(await readFile(executablePath)).equals(bytes)) throw new Error('materialized public entrypoint bytes changed');

    const cases = [];
    for (const definition of profile.cases) {
      const raw = await runExact(process.execPath, [executablePath, ...definition.argv], {
        cwd: executionRoot,
        env: nodeChildEnvironment(),
        deadlineMs: profile.deadlineMs,
        termGraceMs: 250,
      });
      const observation = serializeObservation({ id: definition.id, ...raw });
      cases.push({ id: definition.id, argv: definition.argv, expected: definition.expected, observation, pass: matches(observation, definition.expected) });
    }
    return {
      schemaVersion: 1,
      kind: 'phase1-public-pilot',
      profile: profile.id,
      repository,
      commit: resolved.commit,
      tree: resolved.tree,
      runtime: { executable: process.execPath, nodeVersion: process.versions.node },
      entrypoint: {
        path: profile.entrypoint.path,
        gitBlob: entry.object,
        sha256: digest,
      },
      pass: cases.every((caseResult) => caseResult.pass),
      cases,
    };
  } finally {
    if (resolved?.workspace) await rm(resolved.workspace, { recursive: true, force: true });
  }
}
