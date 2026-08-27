# MDLM Phase 1 qualification harness

This public Node 24 repository provides three separate operations:

- `qualify` checks the source-independent harness with synthetic fixtures, probes, and independent oracles. It never accepts a product repository.
- `controlled-case` executes one typed request in a fresh private workspace.
- `pilot` runs one public product entrypoint from an exact commit against the literal cases in a profile.

The harness uses Node's standard library and Git. Child-process observations retain separate bounded stdout and stderr prefixes as base64, status, signal, deadline, truncation, and cleanup fields. On Linux, timeout handling signals the process group and known descendants with SIGTERM, then SIGKILL. `cleanupComplete: false` makes a check fail. The runner does not claim that it can reap an unknown process that escaped before Linux `/proc` exposed it.

## Requirements

- Node 24, invoked by npm through its absolute `npm_node_execpath`
- Git at `/usr/bin/git`
- Linux for process-group and `/proc` descendant cleanup checks

The npm process is the trusted launch boundary. Remove `NODE_OPTIONS` before starting npm so a preload cannot run in npm or the harness process. An already-running Node process cannot undo code loaded through its own startup options. The supported sanitized form is:

```sh
env -u NODE_OPTIONS npm run self-check
```

Every npm script clears `NODE_OPTIONS` again before it starts the trusted Node executable. Qualification fixtures and preflight self-checks use `process.execPath`. Pilot profiles choose an explicit entrypoint mode. Every child receives a minimal platform environment instead of ambient Node startup options.

## Commands

Run the local integrity check with the sanitized launch form above.

Qualify the synthetic environment:

```sh
env -u NODE_OPTIONS npm run qualify -- \
  --config config/qualification.json \
  --output /tmp/qualification-evidence.json
```

Generate a `realize-verification-environment@1` assignment response after the harness commit is public and immutable. The strategy file must contain one exact VSP datum with `revision_id` and `payload.environment_profile`:

```sh
env -u NODE_OPTIONS npm run generate-preflight -- \
  --repository https://github.com/taylorrowser/mdlm-phase1-qualification-harness.git \
  --commit <exact-40-hex-commit> \
  --assignment <assignment-uuid> \
  --strategy /tmp/exact-vsp.json \
  --output /tmp/realize-environment-response.json
env -u NODE_OPTIONS npm run preflight -- \
  --proposal /tmp/realize-environment-response.json
```

The generated JSON is the scenario response, not a parallel claim. Its ENV payload uses the current `ENV@1` fields, including `reproducibility.environment_ref` and `configuration_digest`. Its VAI payload uses `implementation_ref` and canonical `activity_bindings`. Only scenario-required `$proposal` targets remain in links. Preflight rejects `$proposal` in payload keys or values.

Preflight also accepts exact schema-compatible payload documents:

```sh
env -u NODE_OPTIONS npm run preflight -- --env /tmp/env.json --vai /tmp/vai.json
```

Preflight fetches into a new bare object store with system and global Git configuration disabled. It does not checkout files. It rejects `.lifecycle/`, symlinks, submodules, non-regular entries, path escapes, and object or digest disagreement. It reads exact Git blobs, verifies their manifest Git object IDs and raw SHA-256 values, then materializes only verified bytes in a process-owned temporary directory. The runner executes through `process.execPath`. Success requires the exact structured self-check value, empty stderr, bounded output, and complete reported cleanup.

Run a controlled case whose JSON request declares `controlled-execution@1` and `execution-profile@1`:

```sh
env -u NODE_OPTIONS npm run controlled-case -- \
  --request /tmp/controlled-case-request.json \
  --output /tmp/controlled-case-result.json
```

The request keeps target, runner, `run-exact@2` adapter, and execution-profile identities separate. Entrypoint, stdin, and regular-file fixture bytes use canonical base64 and exact SHA-256 values. The execution profile bounds stdin, fixture sizes, aggregate fixture size, paths, output, and time. It also declares the only environment variables sent to the child, including exact `LANG`, `LC_ALL`, and `TZ` values. The result records setup and post-execution metadata, raw streams, stdin write and EOF evidence, process cleanup, workspace cleanup, truncation, completeness, and typed errors.

The harness rejects unsupported `filesystem-trace@1`, `filesystem-fault-injection@1`, `returned-byte-observation@1`, `network-denial@1`, `network-attempt-observation@1`, and `external-file-access-observation@1` requirements before workspace creation. It does not implement those controls.

Run the public pilot profiles:

```sh
env -u NODE_OPTIONS npm run pilot -- \
  --profile profiles/calculator.json \
  --repository https://github.com/taylorrowser/mdlm-calculator-pilot.git \
  --commit 709497b329505a3c2a6f9d62abe2528099e14aaf \
  --output /tmp/calculator-pilot.json

env -u NODE_OPTIONS npm run pilot -- \
  --profile profiles/temperature.json \
  --repository https://github.com/taylorrowser/mdlm-temperature-pilot.git \
  --commit d4112f81394dc1f65812fee0b2d88ba73ee443ea \
  --output /tmp/temperature-pilot.json
```

Each profile fixes the repository, commit, tree, public entrypoint path, entrypoint Git mode, entrypoint Git blob, entrypoint raw SHA-256, cases, and observations. Pilot fetches Git objects without checkout, rejects unsafe tree entries, verifies the entrypoint bytes, and materializes only that entrypoint. It does not read product test blobs or other product file contents.

A controlled pilot profile adds `capabilities`, exact runner and `run-exact@2` adapter identities, and `executionProfile`. Pilot injects the authenticated target entrypoint bytes and a SHA-256 identity for the profile file, then calls `executeControlledCase` for every case. Each case gets a fresh workspace and may declare stdin and fixtures. Legacy profiles without those fields retain the original entrypoint-only behavior.

The profile must select one entrypoint mode:

- `"runtime": "node"` invokes `process.execPath` with the authenticated entrypoint path as its first argument. Pilot records the Node executable and version.
- `"runtime": "executable"` invokes the authenticated materialized path directly. This mode requires Git mode `100755`; pilot does not infer or select an interpreter.

Pilot rejects other modes, unsafe paths, symlinks, submodules, non-regular files, and executable mode without a Git-authenticated executable bit. Materialized files have mode `0500`. Pilot verifies the file and its permissions before execution and after every case, so entrypoint mutation invalidates the run. Both modes use the same process-group isolation, separate bounded stdout and stderr capture, deadlines, descendant cleanup, and cleanup evidence.

## Preserved JSON Maximum Depth runs

Preserved JSON Maximum Depth run 051 stopped, while run 052 was accepted under the prior qualified harness identity. Adding executable entrypoint mode changes that identity, so these runs cannot use option 6 runner-only recovery. Do not replay or migrate them. Start a fresh lane only after this harness change has been reviewed and qualified.

## Independent checks

`lib/oracles.mjs` parses decimal values into reduced `BigInt` rational numbers. It implements calculator and temperature results without product code or floating-point arithmetic, including 12-place half-away-from-zero rounding and negative-zero normalization.

`qualify` runs Node 24 and raw-stream probes, conforming synthetic fixtures, and deliberately wrong fixtures. Qualification passes only if each probe and fixture case matches the independent oracle, every wrong fixture is detected, output stays within bounds, and cleanup completes.

## Manifest generation

After changing a bound or runtime file, run:

```sh
env -u NODE_OPTIONS npm run manifest
```

`tools/generate-manifest.mjs` computes each Git blob ID from `blob <length>\0<bytes>` and SHA-256 from the raw bytes. `manifest.json` cannot contain its own digest. The generated scenario response binds the manifest path, Git blob, and SHA-256 observed at the exact commit.

## Tests

```sh
env -u NODE_OPTIONS npm test
```

The pilot tests require network access to the two public repositories. The suite runs serially for the four-core development host.

This repository does not publish Lifecycle Data. Evidence output is ordinary JSON at the caller's requested path.
