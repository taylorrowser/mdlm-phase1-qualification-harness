import { randomBytes } from 'node:crypto';
import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

const attempts = 16;
const defaults = { randomBytes, mkdir, rename, rm, writeFile };

export function createEvidenceWriter(dependencies = {}) {
  const operations = { ...defaults, ...dependencies };
  return async function writeEvidenceFile(output, evidence) {
    const destination = path.resolve(output);
    const parent = path.dirname(destination);
    await operations.mkdir(parent, { recursive: true });

    let temporaryDirectory;
    let lastCollision;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      const suffix = operations.randomBytes(16).toString('hex');
      const candidate = path.join(parent, `.${path.basename(destination)}.tmp-${suffix}`);
      try {
        await operations.mkdir(candidate, { mode: 0o700 });
        temporaryDirectory = candidate;
        break;
      } catch (error) {
        if (error.code !== 'EEXIST') throw error;
        lastCollision = error;
      }
    }
    if (!temporaryDirectory) throw new Error(`could not allocate a private temporary directory after ${attempts} attempts`, { cause: lastCollision });

    const temporaryFile = path.join(temporaryDirectory, 'evidence.json');
    let operationError;
    try {
      await operations.writeFile(temporaryFile, `${JSON.stringify(evidence, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
      await operations.rename(temporaryFile, destination);
    } catch (error) {
      operationError = error;
    }

    let cleanupError;
    try {
      await operations.rm(temporaryDirectory, { recursive: true, force: false });
    } catch (error) {
      cleanupError = error;
    }

    if (operationError && cleanupError) {
      throw new AggregateError([operationError, cleanupError], 'evidence write and temporary cleanup both failed');
    }
    if (operationError) throw operationError;
    if (cleanupError) throw cleanupError;
  };
}

export const writeEvidence = createEvidenceWriter();
