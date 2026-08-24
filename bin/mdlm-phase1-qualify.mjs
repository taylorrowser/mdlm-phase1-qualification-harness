#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { lstat, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseOptions, requireSafeRelativePath } from '../lib/common.mjs';
import { writeEvidence } from '../lib/evidence.mjs';
import { calculatorObservation } from '../lib/oracles.mjs';
import { pilot } from '../lib/pilot.mjs';
import { preflight } from '../lib/preflight.mjs';
import { qualify } from '../lib/qualify.mjs';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

async function selfCheck() {
  if (process.versions.node.split('.')[0] !== '24') throw new Error(`Node 24 required, found ${process.versions.node}`);
  const manifest = JSON.parse(await readFile(path.join(root, 'manifest.json'), 'utf8'));
  for (const asset of manifest.assets) {
    requireSafeRelativePath(asset.path, 'manifest asset path');
    const file = path.join(root, asset.path);
    const metadata = await lstat(file);
    if (!metadata.isFile() || metadata.isSymbolicLink()) throw new Error(`invalid manifest asset: ${asset.path}`);
    const bytes = await readFile(file);
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    const gitBlob = createHash('sha1').update(Buffer.from(`blob ${bytes.length}\0`)).update(bytes).digest('hex');
    const mode = metadata.mode & 0o111 ? '100755' : '100644';
    if (sha256 !== asset.sha256 || gitBlob !== asset.gitBlob || mode !== asset.mode) throw new Error(`manifest mismatch: ${asset.path}`);
  }
  if (calculatorObservation(['1', '+', '2']).stdout.toString() !== '3\n') throw new Error('oracle self-check failed');
  return { ok: true, node: process.versions.node, assets: manifest.assets.length };
}

async function main(args) {
  const [command, ...rest] = args;
  if (command === 'self-check' && rest.length === 0) {
    process.stdout.write(`${JSON.stringify(await selfCheck())}\n`);
    return;
  }
  if (command === 'preflight') {
    const options = parseOptions(rest, ['--env', '--vai']);
    const result = await preflight(options['--env'], options['--vai']);
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return;
  }
  if (command === 'qualify') {
    const options = parseOptions(rest, ['--config', '--output']);
    try {
      const evidence = await qualify(options['--config']);
      await writeEvidence(options['--output'], evidence);
      process.stdout.write(`${JSON.stringify({ ok: evidence.pass, output: options['--output'] })}\n`);
      if (!evidence.pass) process.exitCode = 1;
    } catch (error) {
      await writeEvidence(options['--output'], { schemaVersion: 1, kind: 'phase1-environment-qualification', pass: false, error: error.message });
      throw error;
    }
    return;
  }
  if (command === 'pilot') {
    const options = parseOptions(rest, ['--profile', '--repository', '--commit', '--output']);
    try {
      const evidence = await pilot(options['--profile'], options['--repository'], options['--commit']);
      await writeEvidence(options['--output'], evidence);
      process.stdout.write(`${JSON.stringify({ ok: evidence.pass, output: options['--output'] })}\n`);
      if (!evidence.pass) process.exitCode = 1;
    } catch (error) {
      await writeEvidence(options['--output'], { schemaVersion: 1, kind: 'phase1-public-pilot', pass: false, error: error.message });
      throw error;
    }
    return;
  }
  throw new Error(`usage: mdlm-phase1-qualify <self-check|preflight|qualify|pilot>`);
}

main(process.argv.slice(2)).catch((error) => {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
});
