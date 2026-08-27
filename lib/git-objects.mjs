import { isUtf8 } from 'node:buffer';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { requireSafeRelativePath } from './common.mjs';
import { runExact } from './process-runner.mjs';

const gitExecutable = '/usr/bin/git';
const oidPattern = /^[a-f0-9]{40}$/;

function gitEnvironment(home) {
  return {
    HOME: home,
    PATH: '/usr/bin:/bin',
    LANG: 'C',
    LC_ALL: 'C',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_ATTR_NOSYSTEM: '1',
    GIT_TERMINAL_PROMPT: '0',
    GIT_ALLOW_PROTOCOL: 'https:http:file',
  };
}

export async function runGit(cwd, args, options = {}) {
  const result = await runExact(gitExecutable, [
    '--no-pager',
    '-c', 'core.hooksPath=/dev/null',
    '-c', 'protocol.ext.allow=never',
    '-c', 'protocol.ssh.allow=never',
    ...args,
  ], {
    cwd,
    env: gitEnvironment(options.home ?? cwd),
    deadlineMs: options.deadlineMs ?? 10_000,
    termGraceMs: 250,
    maxOutputBytes: options.maxOutputBytes ?? 16 * 1024 * 1024,
  });
  if (result.status !== 0 || result.signal || result.timedOut || result.spawnError ||
      !result.cleanupComplete || !result.streams.complete || result.stdoutTruncated || result.stderrTruncated) {
    const detail = result.stderr.toString('utf8').trim() || `status ${result.status}`;
    throw new Error(`git ${args[0]} failed: ${detail}`);
  }
  return result.stdout;
}

function parseTree(buffer) {
  const entries = new Map();
  let start = 0;
  while (start < buffer.length) {
    const end = buffer.indexOf(0, start);
    if (end < 0) throw new Error('unterminated Git tree record');
    const record = buffer.subarray(start, end);
    const tab = record.indexOf(9);
    if (tab < 0) throw new Error('invalid Git tree record');
    const metadata = record.subarray(0, tab);
    const nameBytes = record.subarray(tab + 1);
    if (!isUtf8(metadata) || !isUtf8(nameBytes)) throw new Error('Git tree paths and metadata must be UTF-8');
    const [mode, type, object] = metadata.toString('utf8').split(' ');
    const name = requireSafeRelativePath(nameBytes.toString('utf8'), 'Git tree path');
    if (entries.has(name)) throw new Error(`duplicate Git tree path: ${name}`);
    entries.set(name, { mode, type, object });
    start = end + 1;
  }
  return entries;
}

export async function fetchExactRepository(repository, expectedCommit, prefix) {
  if (typeof repository !== 'string' || repository.length === 0 || repository.startsWith('-') || repository.includes('\0')) {
    throw new Error('repository must be a nonempty locator');
  }
  if (!oidPattern.test(expectedCommit ?? '')) throw new Error('commit must be an exact 40-hex object ID');
  const workspace = await mkdtemp(path.join(tmpdir(), prefix));
  const objectStore = path.join(workspace, 'objects.git');
  try {
    await runGit(workspace, ['init', '--quiet', '--bare', '--template=', objectStore], { home: workspace });
    await runGit(workspace, ['-C', objectStore, 'fetch', '--quiet', '--no-tags', '--depth=1', '--', repository, expectedCommit], { home: workspace });
    const commit = (await runGit(workspace, ['-C', objectStore, 'rev-parse', 'FETCH_HEAD^{commit}'], { home: workspace })).toString('utf8').trim();
    if (commit !== expectedCommit) throw new Error(`resolved commit ${commit} does not match ${expectedCommit}`);
    const tree = (await runGit(workspace, ['-C', objectStore, 'rev-parse', `${commit}^{tree}`], { home: workspace })).toString('utf8').trim();
    if (!oidPattern.test(tree)) throw new Error('resolved tree is not an exact object ID');
    const entries = parseTree(await runGit(workspace, ['-C', objectStore, 'ls-tree', '-rz', '-r', commit], { home: workspace }));
    return { workspace, objectStore, commit, tree, entries };
  } catch (error) {
    await rm(workspace, { recursive: true, force: true });
    throw error;
  }
}

export async function readBlob(repository, object) {
  if (!oidPattern.test(object ?? '')) throw new Error('blob must be an exact 40-hex object ID');
  return runGit(repository.workspace, ['-C', repository.objectStore, 'cat-file', 'blob', object], {
    home: repository.workspace,
    maxOutputBytes: 16 * 1024 * 1024,
  });
}

export function requireRegularBlob(entry, label) {
  if (!entry) throw new Error(`${label} is missing`);
  if (entry.mode === '120000') throw new Error(`${label} must not be a symlink`);
  if (entry.mode === '160000' || entry.type === 'commit') throw new Error(`${label} must not be a submodule`);
  if (entry.type !== 'blob' || !['100644', '100755'].includes(entry.mode)) {
    throw new Error(`${label} must be a regular file`);
  }
  return entry;
}
