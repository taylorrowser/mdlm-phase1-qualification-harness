#!/usr/bin/env node
import { chmodSync } from 'node:fs';

const [mode] = process.argv.slice(2);

if (mode === 'process-exact') {
  process.stdout.write('process-contract\n');
  process.exitCode = 17;
} else if (mode === 'process-wrong') {
  process.stderr.write('wrong-stream\n');
  process.exitCode = 19;
} else if (mode === 'clean') {
  process.stdout.write('clean\n');
} else if (mode === 'block-workspace') {
  chmodSync('.', 0o000);
} else {
  process.stderr.write('unsupported control mode\n');
  process.exitCode = 2;
}
