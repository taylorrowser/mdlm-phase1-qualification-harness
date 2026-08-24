#!/usr/bin/env node
import { execFile } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const options = Object.fromEntries(Array.from({ length: process.argv.slice(2).length / 2 }, (_, index) => process.argv.slice(2).slice(index * 2, index * 2 + 2)));
const repository = options['--repository'];
const commit = options['--commit'];
const output = options['--output'];
if (!repository || !/^[0-9a-f]{40}$/.test(commit ?? '') || !output) {
  throw new Error('usage: generate-preflight-inputs --repository <url> --commit <40-hex> --output <directory>');
}
const temporary = path.join(output, `.resolve-${process.pid}`);
await mkdir(temporary, { recursive: true });
try {
  await exec('git', ['-C', temporary, 'init', '-q']);
  await exec('git', ['-C', temporary, 'fetch', '-q', '--depth=1', repository, commit], { timeout: 10_000 });
  const resolved = (await exec('git', ['-C', temporary, 'rev-parse', 'FETCH_HEAD^{commit}'], { encoding: 'utf8' })).stdout.trim();
  if (resolved !== commit) throw new Error('repository did not resolve the exact commit');
  const tree = (await exec('git', ['-C', temporary, 'rev-parse', 'FETCH_HEAD^{tree}'], { encoding: 'utf8' })).stdout.trim();
  const config = JSON.parse(await readFile(path.join(root, 'config/qualification.json'), 'utf8'));
  const environment = { repository, commit, tree };
  const env = {
    schemaVersion: 1, environment, manifestPath: 'manifest.json',
    entrypoint: { path: config.bindings.runner, argv: ['self-check'] }, bindings: config.bindings,
  };
  const vai = { schemaVersion: 1, environment, manifestPath: 'manifest.json', bindings: config.bindings };
  await mkdir(output, { recursive: true });
  await writeFile(path.join(output, 'env.json'), `${JSON.stringify(env, null, 2)}\n`);
  await writeFile(path.join(output, 'vai.json'), `${JSON.stringify(vai, null, 2)}\n`);
} finally {
  await import('node:fs/promises').then(({ rm }) => rm(temporary, { recursive: true, force: true }));
}
