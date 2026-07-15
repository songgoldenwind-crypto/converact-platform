import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const contract = readFileSync('docs/ivekit-openapi.md', 'utf8');

const voicePaths = [
  '/api/ivekit/voice/capabilities',
  '/api/ivekit/voice/profiles',
  '/api/ivekit/voice/profiles/:profile_id',
  '/api/ivekit/voice/profiles/:profile_id/preflight',
  '/api/ivekit/voice/profiles/:profile_id/capabilities',
  '/api/ivekit/voice/trunks',
  '/api/ivekit/voice/trunks/:trunk_id',
  '/api/ivekit/voice/trunks/:trunk_id/apply',
  '/api/ivekit/voice/trunks/:trunk_id/test',
  '/api/ivekit/voice/dids',
  '/api/ivekit/voice/dids/:did_id',
  '/api/ivekit/voice/dids/:did_id/apply',
  '/api/ivekit/voice/extensions',
  '/api/ivekit/voice/extensions/:extension_id',
  '/api/ivekit/voice/extensions/:extension_id/apply',
  '/api/ivekit/voice/extensions/:extension_id/session',
  '/api/ivekit/voice/routes',
  '/api/ivekit/voice/routes/:route_id',
  '/api/ivekit/voice/routes/:route_id/validate',
  '/api/ivekit/voice/routes/:route_id/publish',
  '/api/ivekit/voice/routes/:route_id/versions',
  '/api/ivekit/voice/calls',
  '/api/ivekit/voice/calls/:call_id',
  '/api/ivekit/voice/calls/:call_id/actions',
  '/api/ivekit/voice/calls/:call_id/livekit-bridge',
  '/api/ivekit/voice/calls/:call_id/events',
  '/api/ivekit/voice/calls/:call_id/recordings',
  '/api/ivekit/voice/calls/:call_id/bridges',
  '/api/ivekit/voice/calls/:call_id/participants',
  '/api/ivekit/voice/policy',
  '/api/ivekit/voice/consents',
  '/api/ivekit/voice/recordings',
  '/api/ivekit/voice/providers/:profile_id/router',
  '/api/ivekit/voice/providers/:profile_id/events',
  '/api/ivekit/voice/providers/:profile_id/cdrs'
] as const;

const ivrPaths = [
  '/api/ivekit/ivr/flows',
  '/api/ivekit/ivr/flows/:flow_id',
  '/api/ivekit/ivr/flows/:flow_id/versions',
  '/api/ivekit/ivr/flows/:flow_id/validate',
  '/api/ivekit/ivr/flows/:flow_id/publish',
  '/api/ivekit/ivr/flows/:flow_id/rollback',
  '/api/ivekit/ivr/simulations',
  '/api/ivekit/ivr/sessions',
  '/api/ivekit/ivr/sessions/:session_id',
  '/api/ivekit/ivr/sessions/:session_id/advance',
  '/api/ivekit/ivr/settings',
  '/api/ivekit/ivr/audio-assets',
  '/api/ivekit/ivr/audio-assets/:asset_id',
  '/api/ivekit/ivr/time-groups',
  '/api/ivekit/ivr/time-groups/:group_id',
  '/api/ivekit/ivr/region-groups',
  '/api/ivekit/ivr/region-groups/:group_id',
  '/api/ivekit/ivr/ring-groups',
  '/api/ivekit/ivr/ring-groups/:group_id',
  '/api/ivekit/ivr/provider-webhooks/rustpbx/:profile_id/step'
] as const;

const contactCenterPaths = [
  '/api/ivekit/contact-center/capabilities',
  '/api/ivekit/contact-center/monitor',
  '/api/ivekit/contact-center/skills',
  '/api/ivekit/contact-center/skills/:skill_id',
  '/api/ivekit/contact-center/agents',
  '/api/ivekit/contact-center/agents/:agent_id',
  '/api/ivekit/contact-center/agents/:agent_id/presence',
  '/api/ivekit/contact-center/agents/:agent_id/skills',
  '/api/ivekit/contact-center/queues',
  '/api/ivekit/contact-center/queues/:queue_id',
  '/api/ivekit/contact-center/queues/:queue_id/memberships',
  '/api/ivekit/contact-center/queues/:queue_id/memberships/:agent_id',
  '/api/ivekit/contact-center/queues/:queue_id/skill-requirements',
  '/api/ivekit/contact-center/queues/:queue_id/entries',
  '/api/ivekit/contact-center/callbacks',
  '/api/ivekit/contact-center/callbacks/:callback_id',
  '/api/ivekit/contact-center/callbacks/:callback_id/cancel',
  '/api/ivekit/contact-center/routing/assignments',
  '/api/ivekit/contact-center/assignments/:assignment_id/:action',
  '/api/ivekit/contact-center/supervisor/actions'
] as const;

test('iveKit handoff contract inventories every stable Voice, IVR, and Contact Center path', () => {
  for (const path of [...voicePaths, ...ivrPaths, ...contactCenterPaths]) {
    assert.equal(contract.includes(`\`${path}\``), true, path);
  }
});

test('iveKit handoff contract preserves runtime truth and SDK ownership boundaries', () => {
  for (const marker of [
    'IveKitVoiceHttpClient',
    'IveKitIvrHttpClient',
    'IveKitContactCenterHttpClient',
    'Idempotency-Key',
    'capability_schema_version=1',
    'action_capabilities.commands',
    'action_capabilities.conference_operations',
    '501 capability_unavailable',
    'PostgreSQL projection',
    'real_environment.rustpbx=not_run',
    '2026-07-14'
  ]) assert.match(contract, new RegExp(marker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), marker);
});
