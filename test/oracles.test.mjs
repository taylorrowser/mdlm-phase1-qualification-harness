import assert from 'node:assert/strict';
import test from 'node:test';
import { calculatorObservation, temperatureObservation } from '../lib/oracles.mjs';

const ok = (stdout) => ({ status: 0, stdout: Buffer.from(`${stdout}\n`), stderr: Buffer.alloc(0) });
const invalid = { status: 2, stdout: Buffer.alloc(0), stderr: Buffer.from('invalid input\n') };

test('calculator oracle uses exact rationals and half-away-from-zero rounding', () => {
  assert.deepEqual(calculatorObservation(['0.1', '+', '0.2']), ok('0.3'));
  assert.deepEqual(calculatorObservation(['2', '/', '3']), ok('0.666666666667'));
  assert.deepEqual(calculatorObservation(['-0.0000000000005', '+', '0']), ok('-0.000000000001'));
  assert.deepEqual(calculatorObservation(['-0', '*', '99']), ok('0'));
});

test('calculator oracle rejects malformed, omitted, empty, and extra argv distinctly from valid zero', () => {
  for (const argv of [['1e2', '+', '2'], ['1', '+'], ['', '+', '2'], ['1', '+', '2', 'extra']]) {
    assert.deepEqual(calculatorObservation(argv), invalid);
  }
  assert.deepEqual(calculatorObservation(['0', '+', '0']), ok('0'));
});

test('temperature oracle converts exactly, rounds, and enforces absolute zero', () => {
  assert.deepEqual(temperatureObservation(['0', 'C', 'F']), ok('32'));
  assert.deepEqual(temperatureObservation(['32', 'F', 'C']), ok('0'));
  assert.deepEqual(temperatureObservation(['-459.67', 'F', 'K']), ok('0'));
  assert.deepEqual(temperatureObservation(['1', 'C', 'F']), ok('33.8'));
  assert.deepEqual(temperatureObservation(['-273.150000000001', 'C', 'K']), invalid);
});
