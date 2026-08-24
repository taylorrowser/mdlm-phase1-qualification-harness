# MDLM Phase 1 qualification harness

This public Node 24 repository provides two separate operations:

- `qualify` checks the source-independent harness with synthetic fixtures, probes, and independent oracles. It never accepts a product repository.
- `pilot` runs one public product entrypoint from an exact commit against the literal cases in a profile.

The harness uses Node's standard library and Git. Child-process observations retain separate bounded stdout and stderr prefixes as base64, status, signal, deadline, truncation, and cleanup fields. On Linux, timeout handling signals the process group and known descendants with SIGTERM, then SIGKILL. `cleanupComplete: false` makes a check fail. The runner does not claim that it can reap an unknown process that escaped before Linux `/proc` exposed it.

## Requirements

- Node 24, invoked by npm through its absolute `npm_node_execpath`
- Git at `/usr/bin/git`
- Linux for process-group and `/proc` descendant cleanup checks

## Commands

Run the local integrity check:

```sh
npm run self-check
```

Qualify the synthetic environment:

```sh
npm run qualify -- \
  --config config/qualification.json \
  --output /tmp/qualification-evidence.json
```

Generate a `realize-verification-environment@1` assignment response after the harness commit is public and immutable. The strategy file must contain one exact VSP datum with `revision_id` and `payload.environment_profile`:

```sh
npm run generate-preflight -- \
  --repository https://github.com/taylorrowser/mdlm-phase1-qualification-harness.git \
  --commit <exact-40-hex-commit> \
  --assignment <assignment-uuid> \
  --strategy /tmp/exact-vsp.json \
  --output /tmp/realize-environment-response.json
npm run preflight -- \
  --proposal /tmp/realize-environment-response.json
```

The generated JSON is the scenario response, not a parallel claim. Its ENV payload uses the current `ENV@1` fields, including `reproducibility.environment_ref` and `configuration_digest`. Its VAI payload uses `implementation_ref` and canonical `activity_bindings`. Only scenario-required `$proposal` targets remain in links. Preflight rejects `$proposal` in payload keys or values.

Preflight also accepts exact schema-compatible payload documents:

```sh
npm run preflight -- --env /tmp/env.json --vai /tmp/vai.json
```

Preflight fetches into a new bare object store with system and global Git configuration disabled. It does not checkout files. It rejects `.lifecycle/`, symlinks, submodules, non-regular entries, path escapes, and object or digest disagreement. It reads exact Git blobs, verifies their manifest Git object IDs and raw SHA-256 values, then materializes only verified bytes in a process-owned temporary directory. The runner executes through `process.execPath`. Success requires the exact structured self-check value, empty stderr, bounded output, and complete reported cleanup.

Run the public pilot profiles:

```sh
npm run pilot -- \
  --profile profiles/calculator.json \
  --repository https://github.com/taylorrowser/mdlm-calculator-pilot.git \
  --commit 709497b329505a3c2a6f9d62abe2528099e14aaf \
  --output /tmp/calculator-pilot.json

npm run pilot -- \
  --profile profiles/temperature.json \
  --repository https://github.com/taylorrowser/mdlm-temperature-pilot.git \
  --commit d4112f81394dc1f65812fee0b2d88ba73ee443ea \
  --output /tmp/temperature-pilot.json
```

Each profile fixes the repository, commit, tree, public entrypoint path, entrypoint Git blob, entrypoint raw SHA-256, cases, and observations. Pilot fetches Git objects without checkout, rejects unsafe tree entries, verifies the entrypoint bytes, and materializes only that entrypoint. It executes the verified file with `process.execPath`. Pilot records the actual Node executable and version. It does not read product test blobs or other product file contents.

## Independent checks

`lib/oracles.mjs` parses decimal values into reduced `BigInt` rational numbers. It implements calculator and temperature results without product code or floating-point arithmetic, including 12-place half-away-from-zero rounding and negative-zero normalization.

`qualify` runs Node 24 and raw-stream probes, conforming synthetic fixtures, and deliberately wrong fixtures. Qualification passes only if each probe and fixture case matches the independent oracle, every wrong fixture is detected, output stays within bounds, and cleanup completes.

## Manifest generation

After changing a bound or runtime file, run:

```sh
npm run manifest
```

`tools/generate-manifest.mjs` computes each Git blob ID from `blob <length>\0<bytes>` and SHA-256 from the raw bytes. `manifest.json` cannot contain its own digest. The generated scenario response binds the manifest path, Git blob, and SHA-256 observed at the exact commit.

## Tests

```sh
npm test
```

The pilot tests require network access to the two public repositories. The suite runs serially for the four-core development host.

This repository does not publish Lifecycle Data. Evidence output is ordinary JSON at the caller's requested path.
