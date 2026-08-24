#!/usr/bin/env node
const pattern = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/;
const [left, operator, right, ...extra] = process.argv.slice(2);
if (extra.length || !pattern.test(left ?? '') || !pattern.test(right ?? '') || !['+', '-', '*', '/'].includes(operator)) {
  process.stderr.write('invalid input\n');
  process.exit(2);
}
if (operator === '/' && Number(right) === 0) {
  process.stderr.write('division by zero\n');
  process.exit(2);
}
const operations = { '+': (a, b) => a + b, '-': (a, b) => a - b, '*': (a, b) => a * b, '/': (a, b) => a / b };
const value = operations[operator](Number(left), Number(right));
const rounded = Math.round((Math.abs(value) + Number.EPSILON) * 1e12) / 1e12 * Math.sign(value || 1);
process.stdout.write(`${Object.is(rounded, -0) ? 0 : rounded}\n`);
