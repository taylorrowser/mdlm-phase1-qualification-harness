#!/usr/bin/env node
const pattern = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/;
const [text, from, to, ...extra] = process.argv.slice(2);
if (extra.length || !pattern.test(text ?? '') || !['C', 'F', 'K'].includes(from) || !['C', 'F', 'K'].includes(to)) {
  process.stderr.write('invalid input\n');
  process.exit(2);
}
const value = Number(text);
const kelvin = from === 'K' ? value : from === 'C' ? value + 273.15 : (value + 459.67) * 5 / 9;
if (kelvin < 0) {
  process.stderr.write('invalid input\n');
  process.exit(2);
}
const result = to === 'K' ? kelvin : to === 'C' ? kelvin - 273.15 : kelvin * 9 / 5 - 459.67;
const rounded = Math.round((Math.abs(result) + Number.EPSILON) * 1e12) / 1e12 * Math.sign(result || 1);
process.stdout.write(`${Object.is(rounded, -0) ? 0 : rounded}\n`);
