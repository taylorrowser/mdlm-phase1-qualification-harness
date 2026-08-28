#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const configuration = JSON.parse(await readFile(path.join(root, 'config/qualification.json'), 'utf8'));
const capabilityControls = JSON.parse(await readFile(path.join(root, 'config/capability-controls.json'), 'utf8'));
const support = [
  'lib/assessment.mjs',
  'lib/bindings.mjs',
  'lib/capability-controls.mjs',
  'lib/common.mjs',
  'lib/composed-identity.mjs',
  'lib/controlled-execution.mjs',
  'lib/evidence.mjs',
  'lib/env-admission.mjs',
  'lib/execution-identity.mjs',
  'lib/git-objects.mjs',
  'lib/oracles.mjs',
  'lib/pilot.mjs',
  'lib/preflight.mjs',
  'lib/process-runner.mjs',
  'lib/qualify.mjs',
];
const bindingAssets = Object.values(configuration.bindings).flat();
const controlBindingAssets = Object.values(capabilityControls.bindings).flat();
const paths = [...new Set([...bindingAssets, ...controlBindingAssets, ...support])].sort();
const assets = [];
for (const assetPath of paths) {
  const bytes = await readFile(path.join(root, assetPath));
  const metadata = await stat(path.join(root, assetPath));
  const blobHeader = Buffer.from(`blob ${bytes.length}\0`);
  assets.push({
    path: assetPath,
    mode: metadata.mode & 0o111 ? '100755' : '100644',
    gitBlob: createHash('sha1').update(blobHeader).update(bytes).digest('hex'),
    sha256: createHash('sha256').update(bytes).digest('hex'),
  });
}
const manifest = {
  schemaVersion: 1,
  algorithm: { gitBlob: 'sha1', rawBytes: 'sha256' },
  capabilities: configuration.capabilities,
  bindings: { ...configuration.bindings, capabilityControls: capabilityControls.bindings },
  assets,
};
await writeFile(path.join(root, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
