import assert from 'node:assert/strict';
import test from 'node:test';
import {parsePositiveIntegerArg} from './windows-args-common.mjs';

test('parsePositiveIntegerArg returns default value when flag is missing', () => {
  const value = parsePositiveIntegerArg(['node', 'script.mjs'], '--readiness-ms', 25_000);
  assert.equal(value, 25_000);
});

test('parsePositiveIntegerArg parses positive integer values', () => {
  const value = parsePositiveIntegerArg(['node', 'script.mjs', '--readiness-ms=15000'], '--readiness-ms', 25_000);
  assert.equal(value, 15_000);
});

test('parsePositiveIntegerArg floors fractional values', () => {
  const value = parsePositiveIntegerArg(['node', 'script.mjs', '--readiness-ms=15000.9'], '--readiness-ms', 25_000);
  assert.equal(value, 15_000);
});

test('parsePositiveIntegerArg rejects non-numeric values', () => {
  assert.throws(
    () => parsePositiveIntegerArg(['node', 'script.mjs', '--readiness-ms=abc'], '--readiness-ms', 25_000),
    /--readiness-ms must be a positive number, got "abc"/,
  );
});

test('parsePositiveIntegerArg rejects zero or negative values', () => {
  assert.throws(
    () => parsePositiveIntegerArg(['node', 'script.mjs', '--readiness-ms=0'], '--readiness-ms', 25_000),
    /--readiness-ms must be a positive number, got "0"/,
  );
  assert.throws(
    () => parsePositiveIntegerArg(['node', 'script.mjs', '--readiness-ms=-1'], '--readiness-ms', 25_000),
    /--readiness-ms must be a positive number, got "-1"/,
  );
});
