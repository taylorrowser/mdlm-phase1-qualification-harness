#!/usr/bin/env node
if (process.versions.node.split('.')[0] !== '24') {
  process.stderr.write(`requires Node 24, found ${process.versions.node}\n`);
  process.exit(1);
}
process.stdout.write('node24\n');
