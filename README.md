# MDLM Phase 1 qualification harness

This public Node 24 harness qualifies an execution environment without opening a product repository. A separate `pilot` command checks out one exact public product commit and invokes only the public entrypoint and literal argument vectors declared by its profile.

The harness uses only Node's standard library and Git. It records stdout and stderr as separate base64 byte strings, retains bytes emitted before a deadline, runs every case, terminates the process group with SIGTERM and then SIGKILL, waits for descendants to leave the group, and removes temporary checkouts in `finally` blocks.

## Requirements

- Node 24
- Git
- Linux process-group signaling

## Commands

Run the local integrity check:

```sh
node bin/mdlm-phase1-qualify.mjs self-check
```

Qualify the synthetic environment. This command never accepts or opens a product repository:

```sh
node bin/mdlm-phase1-qualify.mjs qualify \
  --config config/qualification.json \
  --output /tmp/qualification-evidence.json
```

Generate ENV and VAI inputs only after the harness commit is public and immutable, then preflight them:

```sh
node tools/generate-preflight-inputs.mjs \
  --repository https://github.com/taylorrowser/mdlm-phase1-qualification-harness.git \
  --commit <exact-40-hex-commit> \
  --output /tmp/phase1-bindings
node bin/mdlm-phase1-qualify.mjs preflight \
  --env /tmp/phase1-bindings/env.json \
  --vai /tmp/phase1-bindings/vai.json
```

Preflight fetches the exact commit, confirms its tree, rejects `$proposal` and `.lifecycle/`, and verifies every bound asset against `manifest.json`: path, regular-file mode, Git blob ID, and raw-byte SHA-256. ENV, VAI, configuration, and manifest bindings must agree. The bound executable must run `self-check`. Every temporary checkout is removed after success or failure.

Run the two public pilot profiles:

```sh
node bin/mdlm-phase1-qualify.mjs pilot \
  --profile profiles/calculator.json \
  --repository https://github.com/taylorrowser/mdlm-calculator-pilot.git \
  --commit 709497b329505a3c2a6f9d62abe2528099e14aaf \
  --output /tmp/calculator-pilot.json

node bin/mdlm-phase1-qualify.mjs pilot \
  --profile profiles/temperature.json \
  --repository https://github.com/taylorrowser/mdlm-temperature-pilot.git \
  --commit d4112f81394dc1f65812fee0b2d88ba73ee443ea \
  --output /tmp/temperature-pilot.json
```

A pilot profile is authoritative. Repository, commit, tree, executable, entrypoint argv, case argv, status, and raw observations are literals. `pilot` does not list or read product source, product tests, or private files. Git exact-checks out the profile commit, the runner checks only the entrypoint's file metadata, and then it executes that entrypoint.

## Independent checks

`lib/oracles.mjs` parses decimal values into reduced `BigInt` rational numbers. It implements calculator and temperature contracts without product code or floating-point arithmetic, including 12-place half-away-from-zero rounding and negative-zero normalization.

`qualify` runs Node 24 and raw-stream probes, conforming synthetic fixtures, and deliberately wrong fixtures. A qualification passes only when every probe and fixture case matches the independent oracle and every wrong fixture is detected.

## Manifest generation

Run this after changing any bound file:

```sh
npm run manifest
```

`tools/generate-manifest.mjs` reads the raw bytes of the fixed asset list. It computes each Git blob ID from `blob <length>\0<bytes>` and computes SHA-256 directly over the bytes. It does not call Git and does not put a commit or digest into its own preimage. `manifest.json` cannot contain its own digest; preflight reports the manifest blob ID and SHA-256 from the resolved commit instead.

## Tests

```sh
npm test
```

The pilot tests require network access to the two public repositories. The suite runs serially to fit the four-core development host.

This repository does not publish Lifecycle Data. Evidence output is ordinary JSON written to the caller's requested path.
