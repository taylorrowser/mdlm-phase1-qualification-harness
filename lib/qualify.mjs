import { lstat, realpath } from 'node:fs/promises';
import path from 'node:path';
import { readJson, requireSafeRelativePath } from './common.mjs';
import { calculatorObservation, temperatureObservation } from './oracles.mjs';
import { runExact, serializeObservation } from './process-runner.mjs';

const oracles = { calculator: calculatorObservation, temperature: temperatureObservation };

function expectedMatches(observation, expected) {
  return observation.status === expected.status &&
    observation.signal === null && !observation.timedOut && !observation.spawnError &&
    observation.stdoutBase64 === expected.stdoutBase64 &&
    observation.stderrBase64 === expected.stderrBase64;
}

async function assetResolver(configPath, config) {
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

export async function qualify(configPath) {
  const config = await readJson(configPath);
  const resolveAsset = await assetResolver(configPath, config);
  const defaults = { deadlineMs: config.deadlineMs, termGraceMs: config.termGraceMs };
  const probes = [];
  for (const probe of config.probes ?? []) {
    const file = await resolveAsset(probe.path, `probe ${probe.id}`);
    const raw = await runExact(process.execPath, [file, ...probe.argv], defaults);
    const observation = serializeObservation({ id: probe.id, ...raw });
    probes.push({ id: probe.id, observation, pass: expectedMatches(observation, probe.expected) });
  }

  const cases = [];
  for (const suite of config.fixtureSuites ?? []) {
    const fixture = await resolveAsset(suite.fixture, `fixture ${suite.id}`);
    const oracle = oracles[suite.oracle];
    if (!oracle) throw new Error(`unknown oracle: ${suite.oracle}`);
    for (const definition of suite.cases) {
      const expectedRaw = oracle(definition.argv);
      const expected = {
        status: expectedRaw.status,
        stdoutBase64: expectedRaw.stdout.toString('base64'),
        stderrBase64: expectedRaw.stderr.toString('base64'),
      };
      const raw = await runExact(process.execPath, [fixture, ...definition.argv], defaults);
      const observation = serializeObservation({ id: `${suite.id}/${definition.id}`, ...raw });
      cases.push({ id: observation.id, argv: definition.argv, expected, observation, pass: expectedMatches(observation, expected) });
    }
  }

  const negativeControls = [];
  for (const control of config.negativeControls ?? []) {
    const fixture = await resolveAsset(control.fixture, `negative control ${control.id}`);
    const oracle = oracles[control.oracle];
    if (!oracle) throw new Error(`unknown oracle: ${control.oracle}`);
    const expectedRaw = oracle(control.argv);
    const expected = {
      status: expectedRaw.status,
      stdoutBase64: expectedRaw.stdout.toString('base64'),
      stderrBase64: expectedRaw.stderr.toString('base64'),
    };
    const raw = await runExact(process.execPath, [fixture, ...control.argv], defaults);
    const observation = serializeObservation({ id: control.id, ...raw });
    negativeControls.push({ id: control.id, argv: control.argv, expected, observation, discriminated: !expectedMatches(observation, expected) });
  }

  const pass = probes.length > 0 && cases.length > 0 && negativeControls.length > 0 &&
    probes.every((probe) => probe.pass) && cases.every((entry) => entry.pass) &&
    negativeControls.every((control) => control.discriminated);
  return { schemaVersion: 1, kind: 'phase1-environment-qualification', pass, probes, cases, negativeControls };
}
