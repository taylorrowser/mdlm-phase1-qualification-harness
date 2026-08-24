import { mkdir, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

export async function writeEvidence(output, evidence) {
  const parent = path.dirname(path.resolve(output));
  await mkdir(parent, { recursive: true });
  const temporary = path.join(parent, `.${path.basename(output)}.${process.pid}.tmp`);
  try {
    await writeFile(temporary, `${JSON.stringify(evidence, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
    await rename(temporary, output);
  } catch (error) {
    try { await import('node:fs/promises').then(({ rm }) => rm(temporary, { force: true })); } catch {}
    throw error;
  }
}
