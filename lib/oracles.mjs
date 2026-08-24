const decimalPattern = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/;
const scale = 1_000_000_000_000n;

function gcd(left, right) {
  left = left < 0n ? -left : left;
  right = right < 0n ? -right : right;
  while (right !== 0n) [left, right] = [right, left % right];
  return left;
}

function rational(numerator, denominator = 1n) {
  if (denominator === 0n) throw new Error('division by zero');
  if (denominator < 0n) [numerator, denominator] = [-numerator, -denominator];
  const divisor = gcd(numerator, denominator);
  return { n: numerator / divisor, d: denominator / divisor };
}

function parseDecimal(value) {
  if (typeof value !== 'string' || !decimalPattern.test(value)) return null;
  const negative = value.startsWith('-');
  const unsigned = value.replace(/^[+-]/, '');
  const [integer = '0', fraction = ''] = unsigned.split('.');
  const denominator = 10n ** BigInt(fraction.length);
  const numerator = BigInt(`${integer || '0'}${fraction}` || '0') * (negative ? -1n : 1n);
  return rational(numerator, denominator);
}

const add = (a, b) => rational(a.n * b.d + b.n * a.d, a.d * b.d);
const subtract = (a, b) => rational(a.n * b.d - b.n * a.d, a.d * b.d);
const multiply = (a, b) => rational(a.n * b.n, a.d * b.d);
const divide = (a, b) => rational(a.n * b.d, a.d * b.n);

export function formatRational(value) {
  const negative = value.n < 0n;
  const absolute = negative ? -value.n : value.n;
  let units = (absolute * scale) / value.d;
  const remainder = (absolute * scale) % value.d;
  if (remainder * 2n >= value.d) units += 1n;
  if (units === 0n) return '0';
  const integer = units / scale;
  const fraction = (units % scale).toString().padStart(12, '0').replace(/0+$/, '');
  return `${negative ? '-' : ''}${integer}${fraction ? `.${fraction}` : ''}`;
}

const success = (value) => ({ status: 0, stdout: Buffer.from(`${formatRational(value)}\n`), stderr: Buffer.alloc(0) });
const invalid = () => ({ status: 2, stdout: Buffer.alloc(0), stderr: Buffer.from('invalid input\n') });

export function calculatorObservation(argv) {
  if (!Array.isArray(argv) || argv.length !== 3) return invalid();
  const [leftText, operator, rightText] = argv;
  const left = parseDecimal(leftText);
  const right = parseDecimal(rightText);
  if (!left || !right || !['+', '-', '*', '/'].includes(operator)) return invalid();
  if (operator === '/' && right.n === 0n) {
    return { status: 2, stdout: Buffer.alloc(0), stderr: Buffer.from('division by zero\n') };
  }
  const operations = { '+': add, '-': subtract, '*': multiply, '/': divide };
  return success(operations[operator](left, right));
}

const constants = {
  absoluteCelsius: rational(27315n, 100n),
  absoluteFahrenheit: rational(45967n, 100n),
  fiveNinths: rational(5n, 9n),
  nineFifths: rational(9n, 5n),
};

export function temperatureObservation(argv) {
  if (!Array.isArray(argv) || argv.length !== 3) return invalid();
  const [text, from, to] = argv;
  const value = parseDecimal(text);
  if (!value || !['C', 'F', 'K'].includes(from) || !['C', 'F', 'K'].includes(to)) return invalid();
  let kelvin;
  if (from === 'K') kelvin = value;
  else if (from === 'C') kelvin = add(value, constants.absoluteCelsius);
  else kelvin = multiply(add(value, constants.absoluteFahrenheit), constants.fiveNinths);
  if (kelvin.n < 0n) return invalid();
  let result;
  if (to === 'K') result = kelvin;
  else if (to === 'C') result = subtract(kelvin, constants.absoluteCelsius);
  else result = subtract(multiply(kelvin, constants.nineFifths), constants.absoluteFahrenheit);
  return success(result);
}
