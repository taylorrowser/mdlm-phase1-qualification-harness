import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { isDeepStrictEqual, promisify } from 'node:util';
import { readJson, rejectProposals, requireSafeRelativePath } from './common.mjs';
import { runExact } from './process-runner.mjs';

const exec = promisify(execFile);
const oid = /^[0-9a-f]{40}$/;
const requiredBindings = ['runner', 'configuration', 'fixtures', 'oracles', 'probes', 'profiles'];

async function git(args, options = {}) {
  const result = await exec('git', args, { encoding: 'buffer', maxBuffer: 16 * 1024 * 1024, timeout: 10_000, ...options });
  return result.stdout;
}

function text(buffer) {
  return buffer.toString('utf8').trim();
}

function bindingPaths(bindings) {
  if (!bindings || typeof bindings !== 'object') throw new Error('missing required bindings');
  const paths = [];
  for (const role of requiredBindings) {
    const value = bindings[role];
    if (role === 'runner' || role === 'configuration') {
      paths.push(requireSafeRelativePath(value, `${role} binding`));
    } else {
      if (!Array.isArray(value) || value.length === 0) throw new Error(`${role} binding must be a nonempty array`);
      for (const entry of value) paths.push(requireSafeRelativePath(entry, `${role} binding`));
    }
  }
  return paths;
}

function parseTree(buffer) {
  const entries = new Map();
  for (const record of buffer.toString('utf8').split('\0').filter(Boolean)) {
    const tab = record.indexOf('\t');
    const [mode, type, object] = record.slice(0, tab).split(' ');
    const name = record.slice(tab + 1);
    entries.set(name, { mode, type, object });
  }
  return entries;
}

async function objectBytes(work, commit, assetPath) {
  return git(['-C', work, 'show', `${commit}:${assetPath}`]);
}

export async function preflight(envPath, vaiPath) {
  const environmentClaim = await readJson(envPath);
  const vai = await readJson(vaiPath);
  rejectProposals(environmentClaim);
  rejectProposals(vai);
  const environment = environmentClaim.environment;
  if (!environment || typeof environment.repository !== 'string' || !oid.test(environment.commit ?? '') || !oid.test(environment.tree ?? '')) {
    throw new Error('ENV must name a repository and exact 40-hex commit and tree objects');
  }
  if (!isDeepStrictEqual(environment, vai.environment)) throw new Error('ENV and VAI environment bindings disagree');
  if (environmentClaim.manifestPath !== vai.manifestPath) throw new Error('ENV and VAI manifest bindings disagree');
  if (!isDeepStrictEqual(environmentClaim.bindings, vai.bindings)) throw new Error('ENV and VAI asset bindings disagree');
  const manifestPath = requireSafeRelativePath(environmentClaim.manifestPath, 'manifest path');
  const paths = bindingPaths(vai.bindings);
  if (environmentClaim.entrypoint?.path !== vai.bindings.runner || !isDeepStrictEqual(environmentClaim.entrypoint.argv, ['self-check'])) {
    throw new Error('ENV entrypoint must invoke the bound runner with self-check');
  }

  const work = await mkdtemp(path.join(tmpdir(), 'mdlm-phase1-preflight-'));
  try {
    await git(['init', '-q', work]);
    await git(['-C', work, 'remote', 'add', 'origin', environment.repository]);
    await git(['-C', work, 'fetch', '-q', '--depth=1', 'origin', environment.commit]);
    const commit = text(await git(['-C', work, 'rev-parse', 'FETCH_HEAD^{commit}']));
    if (commit !== environment.commit) throw new Error(`resolved commit ${commit} does not match ENV ${environment.commit}`);
    const tree = text(await git(['-C', work, 'rev-parse', `${commit}^{tree}`]));
    if (tree !== environment.tree) throw new Error(`resolved tree ${tree} does not match ENV ${environment.tree}`);
    const treeEntries = parseTree(await git(['-C', work, 'ls-tree', '-rz', commit]));
    if ([...treeEntries].some(([name]) => name === '.lifecycle' || name.startsWith('.lifecycle/'))) {
      throw new Error('.lifecycle/ is forbidden in a qualification environment');
    }
    if ([...treeEntries.values()].some((entry) => entry.mode === '120000')) throw new Error('symlink assets are forbidden');

    const manifestEntry = treeEntries.get(manifestPath);
    if (!manifestEntry || manifestEntry.type !== 'blob') throw new Error(`manifest is missing: ${manifestPath}`);
    const manifestBytes = await objectBytes(work, commit, manifestPath);
    let manifest;
    try { manifest = JSON.parse(manifestBytes.toString('utf8')); } catch (error) { throw new Error(`invalid manifest JSON: ${error.message}`); }
    if (!isDeepStrictEqual(manifest.bindings, vai.bindings)) throw new Error('manifest and VAI bindings disagree');
    const configurationBytes = await objectBytes(work, commit, vai.bindings.configuration);
    let configuration;
    try { configuration = JSON.parse(configurationBytes.toString('utf8')); } catch (error) { throw new Error(`invalid configuration JSON: ${error.message}`); }
    if (!isDeepStrictEqual(configuration.bindings, vai.bindings)) throw new Error('configuration and VAI bindings disagree');
    if (!Array.isArray(manifest.assets)) throw new Error('manifest assets must be an array');
    const declared = new Set();
    for (const asset of manifest.assets) {
      requireSafeRelativePath(asset.path, 'manifest asset path');
      if (declared.has(asset.path)) throw new Error(`duplicate manifest asset: ${asset.path}`);
      declared.add(asset.path);
      const entry = treeEntries.get(asset.path);
      if (!entry || entry.type !== 'blob') throw new Error(`manifest asset is missing: ${asset.path}`);
      if (entry.mode !== asset.mode) throw new Error(`file mode mismatch for ${asset.path}`);
      if (entry.object !== asset.gitBlob) throw new Error(`Git blob mismatch for ${asset.path}`);
      const bytes = await objectBytes(work, commit, asset.path);
      const digest = createHash('sha256').update(bytes).digest('hex');
      if (digest !== asset.sha256) throw new Error(`SHA-256 mismatch for ${asset.path}`);
    }
    for (const assetPath of paths) if (!declared.has(assetPath)) throw new Error(`bound asset absent from manifest: ${assetPath}`);
    const runnerEntry = treeEntries.get(vai.bindings.runner);
    if (runnerEntry.mode !== '100755') throw new Error('runner entrypoint is not executable');

    await git(['-C', work, 'checkout', '-q', '--detach', commit]);
    const check = await runExact(path.join(work, vai.bindings.runner), ['self-check'], { cwd: work, deadlineMs: 5_000, termGraceMs: 250 });
    if (check.status !== 0 || check.signal || check.timedOut || check.spawnError) {
      throw new Error(`self-check failed: ${check.stderr.toString('utf8').trim() || `status ${check.status}`}`);
    }
    return {
      ok: true,
      repository: environment.repository,
      commit,
      tree,
      manifest: { path: manifestPath, gitBlob: manifestEntry.object, sha256: createHash('sha256').update(manifestBytes).digest('hex') },
      selfCheck: { status: check.status, stdoutBase64: check.stdout.toString('base64'), stderrBase64: check.stderr.toString('base64') },
    };
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}
