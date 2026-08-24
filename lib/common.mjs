import { readFile } from 'node:fs/promises';
import path from 'node:path';

export async function readJson(file) {
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch (error) {
    throw new Error(`cannot read JSON ${file}: ${error.message}`);
  }
}

export function requireSafeRelativePath(value, label = 'path') {
  if (typeof value !== 'string' || value.length === 0 || value.includes('\\') || value.includes('\0')) {
    throw new Error(`${label} must be a nonempty portable relative path`);
  }
  const normalized = path.posix.normalize(value);
  if (normalized !== value || path.posix.isAbsolute(value) || value === '..' || value.startsWith('../')) {
    throw new Error(`${label} escapes the environment: ${value}`);
  }
  return value;
}

export function rejectProposals(value, location = '$') {
  if (typeof value === 'string' && value.includes('$proposal')) {
    throw new Error(`unresolved $proposal placeholder at ${location}`);
  }
  if (Array.isArray(value)) {
    value.forEach((entry, index) => rejectProposals(entry, `${location}[${index}]`));
  } else if (value && typeof value === 'object') {
    for (const [key, entry] of Object.entries(value)) {
      if (key.includes('$proposal')) throw new Error(`unresolved $proposal placeholder in key at ${location}`);
      rejectProposals(entry, `${location}.${key}`);
    }
  }
}

export function parseOptions(args, names) {
  const options = {};
  for (let index = 0; index < args.length; index += 2) {
    const name = args[index];
    if (!names.includes(name) || index + 1 >= args.length) throw new Error(`invalid option: ${name ?? '<missing>'}`);
    if (options[name] !== undefined) throw new Error(`duplicate option: ${name}`);
    options[name] = args[index + 1];
  }
  for (const name of names) if (options[name] === undefined) throw new Error(`missing option: ${name}`);
  return options;
}
