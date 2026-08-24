#!/usr/bin/env node
process.stdout.write(Buffer.from([0, 255]));
process.stderr.write(Buffer.from([254, 1]));
process.exit(23);
