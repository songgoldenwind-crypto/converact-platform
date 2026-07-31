import assert from 'node:assert/strict';
import test from 'node:test';

import {
  IVEKIT_INTEGRATION_EVENT_CATALOG,
  matchesIveKitEventPattern,
  normalizeIveKitEventPatterns
} from '../src/agent-runtime/ivekit/integration-events/catalog.js';

test('integration event catalog covers every shared foundation domain', () => {
  assert.equal(IVEKIT_INTEGRATION_EVENT_CATALOG.schema_version, 1);
  assert.deepEqual(
    IVEKIT_INTEGRATION_EVENT_CATALOG.families.map((family) => family.id),
    ['chat', 'file', 'intelligence', 'media', 'notification', 'provider', 'remote', 'voice']
  );
  assert.equal(IVEKIT_INTEGRATION_EVENT_CATALOG.pattern_syntax, 'exact_or_trailing_wildcard');
  assert.equal(IVEKIT_INTEGRATION_EVENT_CATALOG.webhook_signature_version, 'v1');
  assert.equal(IVEKIT_INTEGRATION_EVENT_CATALOG.compatibility, 'additive');
});

test('event patterns accept exact values and a trailing family wildcard only', () => {
  assert.deepEqual(normalizeIveKitEventPatterns([
    'notification.*',
    'collaboration.message.created',
    'notification.*'
  ]), ['collaboration.message.created', 'notification.*']);
  assert.equal(matchesIveKitEventPattern('notification.delivery.updated', ['notification.*']), true);
  assert.equal(matchesIveKitEventPattern('notification', ['notification.*']), false);
  assert.equal(matchesIveKitEventPattern(
    'collaboration.message.created', ['collaboration.message.created']
  ), true);
  assert.throws(() => normalizeIveKitEventPatterns(['*']), /event pattern/i);
  assert.throws(() => normalizeIveKitEventPatterns(['notification.*.updated']), /event pattern/i);
  assert.throws(() => normalizeIveKitEventPatterns([]), /event pattern/i);
});
