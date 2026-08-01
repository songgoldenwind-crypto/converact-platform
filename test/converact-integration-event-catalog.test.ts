import assert from 'node:assert/strict';
import test from 'node:test';

import {
  CONVERACT_FABRIC_INTEGRATION_EVENT_CATALOG,
  matchesConveractFabricEventPattern,
  normalizeConveractFabricEventPatterns
} from '../src/agent-runtime/converact/integration-events/catalog.js';

test('integration event catalog covers every shared foundation domain', () => {
  assert.equal(CONVERACT_FABRIC_INTEGRATION_EVENT_CATALOG.schema_version, 1);
  assert.deepEqual(
    CONVERACT_FABRIC_INTEGRATION_EVENT_CATALOG.families.map((family) => family.id),
    ['chat', 'file', 'intelligence', 'media', 'notification', 'provider', 'remote', 'voice']
  );
  assert.equal(CONVERACT_FABRIC_INTEGRATION_EVENT_CATALOG.pattern_syntax, 'exact_or_trailing_wildcard');
  assert.equal(CONVERACT_FABRIC_INTEGRATION_EVENT_CATALOG.webhook_signature_version, 'v1');
  assert.equal(CONVERACT_FABRIC_INTEGRATION_EVENT_CATALOG.compatibility, 'additive');
});

test('event patterns accept exact values and a trailing family wildcard only', () => {
  assert.deepEqual(normalizeConveractFabricEventPatterns([
    'notification.*',
    'collaboration.message.created',
    'notification.*'
  ]), ['collaboration.message.created', 'notification.*']);
  assert.equal(matchesConveractFabricEventPattern('notification.delivery.updated', ['notification.*']), true);
  assert.equal(matchesConveractFabricEventPattern('notification', ['notification.*']), false);
  assert.equal(matchesConveractFabricEventPattern(
    'collaboration.message.created', ['collaboration.message.created']
  ), true);
  assert.throws(() => normalizeConveractFabricEventPatterns(['*']), /event pattern/i);
  assert.throws(() => normalizeConveractFabricEventPatterns(['notification.*.updated']), /event pattern/i);
  assert.throws(() => normalizeConveractFabricEventPatterns([]), /event pattern/i);
});
