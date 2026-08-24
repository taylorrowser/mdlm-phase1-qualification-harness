import { lstat, mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { readJson, rejectProposals, requireSafeRelativePath } from './common.mjs';
import { runExact, serializeObservation } from './process-runner.mjs';

const oid = /^[0-9a-f]{40}$/;

async function git(cwd, args) {
  const result = await runExact('git', args, { cwd, deadlineMs: 10_000, termGraceMs: 250 });
  if (result.status !== 0 || result.signal || result.timedOut || result.spawnError) {
    throw new Error(`git ${args[0]} failed: ${result.stderr.toString('utf8').trim() || `status ${result.status}`}`);
  }
  return result.stdout.toString('utf8').trim();
}

function matches(observation, expected) {
  return observation.status === expected.status && observation.signal === null &&
    !observation.timedOut && !observation.spawnError &&
    observation.stdoutBase64 === expected.stdoutBase64 && observation.stderrBase64 === expected.stderrBase64;
}

function validateLiteralProfile(profile) {
  rejectProposals(profile);
  if (!oid.test(profile.commit ?? '') || !oid.test(profile.tree ?? '')) throw new Error('profile must declare exact commit and tree IDs');
  if (!profile.entrypoint || typeof profile.entrypoint.executable !== 'string' || !Array.isArray(profile.entrypoint.argv) || profile.entrypoint.argv.length === 0) {
    throw new Error('profile must declare an executable and entrypoint argv');
  }
  for (const value of profile.entrypoint.argv) if (typeof value !== 'string') throw new Error('entrypoint argv must be literal strings');
  requireSafeRelativePath(profile.entrypoint.argv[0], 'public entrypoint');
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

  const checkout = await mkdtemp(path.join(tmpdir(), 'mdlm-phase1-pilot-'));
  try {
    await git(checkout, ['init', '-q']);
    await git(checkout, ['remote', 'add', 'origin', repository]);
    await git(checkout, ['fetch', '-q', '--depth=1', 'origin', commit]);
    const resolvedCommit = await git(checkout, ['rev-parse', 'FETCH_HEAD^{commit}']);
    if (resolvedCommit !== commit) throw new Error(`resolved commit mismatch: ${resolvedCommit}`);
    const resolvedTree = await git(checkout, ['rev-parse', 'FETCH_HEAD^{tree}']);
    if (resolvedTree !== profile.tree) throw new Error(`resolved tree mismatch: ${resolvedTree}`);
    await git(checkout, ['checkout', '-q', '--detach', resolvedCommit]);

    const entrypoint = path.resolve(checkout, profile.entrypoint.argv[0]);
    const metadata = await lstat(entrypoint);
    if (!metadata.isFile() || metadata.isSymbolicLink()) throw new Error('public entrypoint must be a regular non-symlink file');
    if (await realpath(entrypoint) !== entrypoint) throw new Error('public entrypoint escapes checkout');

    const cases = [];
    for (const definition of profile.cases) {
      const raw = await runExact(profile.entrypoint.executable, [...profile.entrypoint.argv, ...definition.argv], {
        cwd: checkout,
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
      commit: resolvedCommit,
      tree: resolvedTree,
      entrypoint: profile.entrypoint,
      pass: cases.every((entry) => entry.pass),
      cases,
    };
  } finally {
    await rm(checkout, { recursive: true, force: true });
  }
}
