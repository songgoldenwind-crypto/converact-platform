import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { parse } from 'yaml';

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

const rustDeskAuthorizationPaths = [
  '/api/ivekit/rustdesk/authorization-codes',
  '/api/ivekit/rustdesk/authorization-codes/:authorization_id',
  '/api/ivekit/rustdesk/authorization-codes/:authorization_id/verify'
] as const;

const rustDeskEdgePaths = [
  '/api/ivekit/rustdesk/edge/heartbeat',
  '/api/ivekit/rustdesk/devices/:device_id/commands/claim',
  '/api/ivekit/rustdesk/devices/:device_id/commands/:command_id/progress',
  '/api/ivekit/rustdesk/devices/:device_id/commands/:command_id/result',
  '/api/ivekit/rustdesk/devices/:device_id/commands/:command_id/recover',
  '/api/ivekit/rustdesk/devices/:device_id/observations',
  '/api/ivekit/rustdesk/devices/:device_id/evidence-context',
  '/api/ivekit/rustdesk/devices/:device_id/evidence',
  '/api/ivekit/rustdesk/devices/:device_id/evidence/:file_id/content',
  '/api/ivekit/rustdesk/devices/:device_id/evidence/:file_id/parts[/:part_number]',
  '/api/ivekit/rustdesk/devices/:device_id/evidence/:file_id/complete',
  '/api/ivekit/rustdesk/devices/:device_id/evidence/:file_id'
] as const;

const notificationPaths = [
  '/api/ivekit/notifications/capabilities',
  '/api/ivekit/notifications',
  '/api/ivekit/notifications/:notification_id',
  '/api/ivekit/notifications/inbox',
  '/api/ivekit/notifications/inbox/unread-count',
  '/api/ivekit/notifications/inbox/:item_id/:action',
  '/api/ivekit/notifications/endpoints',
  '/api/ivekit/notifications/endpoints/:endpoint_id',
  '/api/ivekit/notifications/endpoints/:endpoint_id/test',
  '/api/ivekit/notifications/endpoints/:endpoint_id/archive',
  '/api/ivekit/notifications/templates',
  '/api/ivekit/notifications/templates/:template_id',
  '/api/ivekit/notifications/templates/:template_id/versions',
  '/api/ivekit/notifications/templates/:template_id/publish',
  '/api/ivekit/notifications/templates/:template_id/archive',
  '/api/ivekit/notifications/preferences',
  '/api/ivekit/notifications/preferences/:event_type/:channel',
  '/api/ivekit/notifications/deliveries',
  '/api/ivekit/notifications/deliveries/:delivery_id',
  '/api/ivekit/notifications/deliveries/:delivery_id/retry',
  '/api/ivekit/notifications/provider-receipts/:endpoint_id'
] as const;

const eventPaths = [
  '/api/ivekit/events',
  '/api/ivekit/events/catalog',
  '/api/ivekit/events/webhook-subscriptions',
  '/api/ivekit/events/webhook-subscriptions/:subscription_id',
  '/api/ivekit/events/webhook-subscriptions/:subscription_id/archive'
] as const;

test('iveKit handoff contract inventories every stable Voice, IVR, and Contact Center path', () => {
  for (const path of [...voicePaths, ...ivrPaths, ...contactCenterPaths]) {
    assert.equal(contract.includes(`\`${path}\``), true, path);
  }
});

test('iveKit handoff contract documents the one-time RustDesk authorization exchange', () => {
  for (const path of rustDeskAuthorizationPaths) {
    assert.equal(contract.includes(`\`${path}\``), true, path);
  }
  for (const marker of [
    'OPC_RUSTDESK_REQUIRE_AUTHORIZATION_CODE=1',
    'OPC_RUSTDESK_AUTHORIZATION_CODE_SECRET',
    'requestAuthorizationCode',
    'verifyAuthorizationCode',
    'code:null,replayed:true'
  ]) assert.match(contract, new RegExp(marker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), marker);
});

test('iveKit handoff contract documents device-bound RustDesk observation ingestion', () => {
  for (const path of rustDeskEdgePaths) {
    assert.equal(contract.includes(`\`${path}\``), true, path);
  }
  for (const marker of [
    'x-rustdesk-edge-token',
    'source_adapter',
    'received -> forwarding -> forwarded|dead_letter',
    'OPC_RUSTDESK_EDGE_OBSERVATION_INPUT_DIR',
    'OPC_RUSTDESK_EDGE_OBSERVATION_SPOOL_DIR',
    'OPC_RUSTDESK_EDGE_EVIDENCE_INPUT_DIR',
    'OPC_RUSTDESK_EDGE_EVIDENCE_SPOOL_DIR',
    'ivekit_secure_file',
    'native_unscanned',
    'local_only'
  ]) assert.match(contract, new RegExp(marker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), marker);
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

test('iveKit handoff contract inventories notification user and administration paths', () => {
  for (const path of notificationPaths) {
    assert.equal(contract.includes(`\`${path}\``), true, path);
  }
  for (const marker of [
    'IveKitNotificationHttpClient',
    'active_health_checks',
    'failed|dead_letter -> retry_wait',
    'uncertain',
    'OPC_IVEKIT_NOTIFICATION_HEALTH_WORKER_ENABLED',
    'opc_ivekit_notification_health_probes_total'
  ]) assert.match(contract, new RegExp(marker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), marker);
});

test('iveKit handoff contract documents durable integration event webhooks', () => {
  for (const path of eventPaths) {
    assert.equal(contract.includes(`\`${path}\``), true, path);
  }
  for (const marker of [
    'migration 073',
    'IveKitEventHttpClient',
    'verifyIveKitWebhook',
    'IveKitWebhookReplayStore',
    'body SHA-256',
    'durable inbox',
    'OPC_IVEKIT_EVENT_WEBHOOK_WORKER_ENABLED'
  ]) assert.match(contract, new RegExp(marker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), marker);
});

test('OpenAPI 3.1 publishes the outbound signed integration webhook contract', () => {
  const openapi = parse(readFileSync('docs/openapi.yaml', 'utf8')) as any;
  const operation = openapi.webhooks.iveKitIntegrationEvent.post;
  assert.equal(openapi.openapi, '3.1.0');
  assert.equal(
    operation.requestBody.content['application/json'].schema.$ref,
    '#/components/schemas/IveKitIntegrationWebhookDelivery'
  );
  assert.deepEqual(operation.parameters.map((parameter: any) => parameter.name), [
    'x-ivekit-timestamp', 'x-ivekit-signature', 'x-ivekit-delivery',
    'x-ivekit-event', 'x-ivekit-event-id', 'x-ivekit-idempotency-key'
  ]);
  assert.ok(openapi.paths['/api/ivekit/events/webhook-subscriptions']);
});

test('OpenAPI publishes Tinode mutation dead-letter reconciliation contracts', () => {
  const openapi = parse(readFileSync('docs/openapi.yaml', 'utf8')) as any;
  const list = openapi.paths[
    '/api/ivekit/chat/operations/tinode/mutation-dead-letters'
  ];
  const replay = openapi.paths[
    '/api/ivekit/chat/operations/tinode/mutation-dead-letters/{outbox_id}/replay'
  ];

  assert.equal(
    list.get.responses['200'].content['application/json'].schema
      .properties.items.items.$ref,
    '#/components/schemas/IveKitTinodeMutationDeadLetter'
  );
  assert.equal(
    replay.post.responses['202'].content['application/json'].schema.$ref,
    '#/components/schemas/IveKitTinodeMutationDeadLetterReplay'
  );
  assert.match(replay.post.description, /unknown publish outcome/i);
  assert.ok(openapi.components.schemas.IveKitTinodeMutationDeadLetter);
  assert.ok(openapi.components.schemas.IveKitTinodeMutationDeadLetterReplay);
});

test('OpenAPI publishes RustDesk targeted disconnect and native evidence edge contracts', () => {
  const openapi = parse(readFileSync('docs/openapi.yaml', 'utf8')) as any;
  const disconnect = openapi.paths[
    '/api/ivekit/rustdesk/gateway-sessions/{external_id}/disconnect'
  ];
  const fallback = openapi.paths[
    '/api/ivekit/rustdesk/gateway-sessions/{external_id}/disconnect/emergency-fallback'
  ];
  const evidenceRoot = openapi.paths[
    '/api/ivekit/rustdesk/devices/{device_id}/evidence'
  ];
  const evidenceContext = openapi.paths[
    '/api/ivekit/rustdesk/devices/{device_id}/evidence-context'
  ];
  const commandClaim = openapi.paths[
    '/api/ivekit/rustdesk/devices/{device_id}/commands/claim'
  ];
  const commandLifecyclePaths = [
    '/api/ivekit/rustdesk/devices/{device_id}/commands/{command_id}/progress',
    '/api/ivekit/rustdesk/devices/{device_id}/commands/{command_id}/result',
    '/api/ivekit/rustdesk/devices/{device_id}/commands/{command_id}/recover'
  ];
  const evidencePaths = [
    '/api/ivekit/rustdesk/devices/{device_id}/evidence/{file_id}',
    '/api/ivekit/rustdesk/devices/{device_id}/evidence/{file_id}/content',
    '/api/ivekit/rustdesk/devices/{device_id}/evidence/{file_id}/parts',
    '/api/ivekit/rustdesk/devices/{device_id}/evidence/{file_id}/parts/{part_number}',
    '/api/ivekit/rustdesk/devices/{device_id}/evidence/{file_id}/complete'
  ];

  assert.ok(disconnect.get);
  assert.equal(
    fallback.post.requestBody.content['application/json'].schema.$ref,
    '#/components/schemas/IveKitRustDeskEmergencyFallbackInput'
  );
  assert.equal(
    openapi.components.schemas.IveKitRustDeskEmergencyFallbackInput
      .properties.collateral_sessions_may_disconnect.const,
    true
  );
  assert.deepEqual(evidenceRoot.post.security, [{ RustDeskEdgeToken: [] }]);
  assert.deepEqual(evidenceContext.get.security, [{ RustDeskEdgeToken: [] }]);
  assert.equal(
    evidenceContext.get.responses['200'].content['application/json'].schema.$ref,
    '#/components/schemas/IveKitRustDeskNativeEvidenceContextResponse'
  );
  assert.deepEqual(commandClaim.post.security, [{ RustDeskEdgeToken: [] }]);
  assert.equal(
    commandClaim.post.responses['201'].content['application/json'].schema.$ref,
    '#/components/schemas/IveKitRustDeskEdgeCommandClaimResponse'
  );
  assert.ok(
    openapi.components.schemas.IveKitRustDeskEdgeClaimCommand
      .required.includes('controller_rustdesk_id')
  );
  assert.equal(
    evidenceRoot.post.requestBody.content['application/json'].schema.$ref,
    '#/components/schemas/IveKitRustDeskNativeEvidenceCreate'
  );
  assert.equal(openapi.components.securitySchemes.RustDeskEdgeToken.name, 'X-RustDesk-Edge-Token');
  assert.deepEqual(
    openapi.components.schemas.IveKitRustDeskNativeEvidenceCreate.properties.kind.enum,
    ['file', 'screen_recording']
  );
  for (const path of evidencePaths) assert.ok(openapi.paths[path], path);
  for (const path of commandLifecyclePaths) assert.ok(openapi.paths[path], path);
  assert.ok(openapi.paths['/api/ivekit/rustdesk/devices/{device_id}/observations'].post);
});
