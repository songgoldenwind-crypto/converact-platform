import { resolveConveractEnv } from '../src/config/converact-env.js';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { validateEnv, type EnvValidationResult } from '../src/env-config.js';

function parseResult(result: EnvValidationResult) {
  return {
    errors: result.errors,
    warnings: result.warnings
  };
}

test('validateEnv: production mode fails when DATABASE_URL missing', () => {
  const prev = { NODE_ENV: process.env.NODE_ENV, DATABASE_URL: process.env.DATABASE_URL };
  process.env.NODE_ENV = 'production';
  delete process.env.DATABASE_URL;
  try {
    const result = parseResult(validateEnv());
    assert.ok(result.errors.some((e) => e.includes('DATABASE_URL')),
      'should error on missing DATABASE_URL in production');
  } finally {
    process.env.NODE_ENV = prev.NODE_ENV;
    if (prev.DATABASE_URL) process.env.DATABASE_URL = prev.DATABASE_URL;
  }
});

test('validateEnv: non-production does not fail on missing DATABASE_URL', () => {
  const prev = { NODE_ENV: process.env.NODE_ENV, DATABASE_URL: process.env.DATABASE_URL };
  process.env.NODE_ENV = 'development';
  delete process.env.DATABASE_URL;
  try {
    const result = parseResult(validateEnv());
    assert.equal(result.errors.length, 0,
      'should not error on missing DATABASE_URL in development');
    assert.ok(result.warnings.some((w) => w.includes('DATABASE_URL')),
      'should warn on missing DATABASE_URL in development');
  } finally {
    process.env.NODE_ENV = prev.NODE_ENV;
    if (prev.DATABASE_URL) process.env.DATABASE_URL = prev.DATABASE_URL;
  }
});

test('validateEnv: production accepts discrete PostgreSQL connection variables', () => {
  const keys = ['NODE_ENV', 'DATABASE_URL', 'PGHOST', 'PGDATABASE', 'PGUSER', 'PGPASSWORD'] as const;
  const previous = Object.fromEntries(keys.map((key) => [key, resolveConveractEnv(process.env, key)]));
  process.env.NODE_ENV = 'production';
  delete process.env.DATABASE_URL;
  process.env.PGHOST = 'postgres';
  process.env.PGDATABASE = 'opc';
  process.env.PGUSER = 'opc_runtime';
  process.env.PGPASSWORD = 'runtime-secret';
  try {
    const result = parseResult(validateEnv());
    assert.equal(result.errors.some((error) => error.includes('DATABASE_URL')), false);
  } finally {
    for (const key of keys) {
      const value = previous[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test('validateEnv: warns when LiveKit credentials missing', () => {
  const prev = {
    NODE_ENV: process.env.NODE_ENV,
    LIVEKIT_URL: process.env.LIVEKIT_URL,
    LIVEKIT_API_KEY: process.env.LIVEKIT_API_KEY,
    LIVEKIT_API_SECRET: process.env.LIVEKIT_API_SECRET
  };
  process.env.NODE_ENV = 'production';
  process.env.LIVEKIT_URL = 'ws://localhost:7880';
  delete process.env.LIVEKIT_API_KEY;
  delete process.env.LIVEKIT_API_SECRET;
  try {
    const result = parseResult(validateEnv());
    assert.ok(result.warnings.some((w) => w.includes('LIVEKIT_API')),
      'should warn on missing LiveKit credentials');
  } finally {
    process.env.NODE_ENV = prev.NODE_ENV;
    if (prev.LIVEKIT_URL !== undefined) process.env.LIVEKIT_URL = prev.LIVEKIT_URL;
    if (prev.LIVEKIT_API_KEY !== undefined) process.env.LIVEKIT_API_KEY = prev.LIVEKIT_API_KEY;
    if (prev.LIVEKIT_API_SECRET !== undefined) process.env.LIVEKIT_API_SECRET = prev.LIVEKIT_API_SECRET;
  }
});

test('validateEnv: passes clean when all required vars present', () => {
  const prev = {
    NODE_ENV: process.env.NODE_ENV,
    DATABASE_URL: process.env.DATABASE_URL,
    LIVEKIT_URL: process.env.LIVEKIT_URL,
    LIVEKIT_API_KEY: process.env.LIVEKIT_API_KEY,
    LIVEKIT_API_SECRET: process.env.LIVEKIT_API_SECRET
  };
  process.env.NODE_ENV = 'production';
  process.env.DATABASE_URL = 'postgres://localhost/opc';
  process.env.LIVEKIT_URL = 'ws://localhost:7880';
  process.env.LIVEKIT_API_KEY = 'key';
  process.env.LIVEKIT_API_SECRET = 'secret';
  try {
    const result = parseResult(validateEnv());
    assert.equal(result.errors.length, 0, 'no errors when all required present');
  } finally {
    process.env.NODE_ENV = prev.NODE_ENV;
    if (prev.DATABASE_URL !== undefined) process.env.DATABASE_URL = prev.DATABASE_URL;
    if (prev.LIVEKIT_URL !== undefined) process.env.LIVEKIT_URL = prev.LIVEKIT_URL;
    if (prev.LIVEKIT_API_KEY !== undefined) process.env.LIVEKIT_API_KEY = prev.LIVEKIT_API_KEY;
    if (prev.LIVEKIT_API_SECRET !== undefined) process.env.LIVEKIT_API_SECRET = prev.LIVEKIT_API_SECRET;
  }
});
