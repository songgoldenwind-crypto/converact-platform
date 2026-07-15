import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import {
  normalizeVoiceActionCapabilities,
  supportsVoiceCommand,
  VOICE_CAPABILITY_SCHEMA_VERSION,
  VOICE_COMMAND_KINDS
} from '../src/agent-runtime/ivekit/voice/index.js';

test('Voice action capabilities are versioned, complete, and fail closed', () => {
  const empty = normalizeVoiceActionCapabilities();
  assert.equal(VOICE_CAPABILITY_SCHEMA_VERSION, 1);
  assert.deepEqual(Object.keys(empty.commands), [...VOICE_COMMAND_KINDS]);
  assert.equal(Object.values(empty.commands).every((enabled) => enabled === false), true);
  assert.equal(supportsVoiceCommand(empty, 'park'), false);

  const conference = normalizeVoiceActionCapabilities({
    commands: { conference: true },
    conference_operations: { add: true }
  });
  assert.equal(supportsVoiceCommand(conference, 'conference', { operation: 'add' }), true);
  assert.equal(supportsVoiceCommand(conference, 'conference', { operation: 'destroy' }), false);
  assert.equal(supportsVoiceCommand(undefined, 'hangup'), false);
});

test('Voice action capability migration is forward-only and preserves legacy snapshots', () => {
  const sql = readFileSync('src/migrations/057_ivekit_voice_action_capabilities.sql', 'utf8');
  assert.match(sql, /ADD COLUMN IF NOT EXISTS capability_schema_version INTEGER NOT NULL DEFAULT 1/);
  assert.match(sql, /ADD COLUMN IF NOT EXISTS action_capabilities JSONB NOT NULL DEFAULT '\{\}'::JSONB/);
  assert.match(sql, /CHECK \(capability_schema_version = 1\)/);
  assert.doesNotMatch(sql, /\bDROP\b|\bDELETE\b|\bTRUNCATE\b/i);
});
