import { resolveFabricEnv } from '../src/config/converact-env.js';
import { createHash, createHmac } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  statSync,
  writeFileSync
} from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  IVEKIT_INTEGRATION_EVENT_CATALOG,
  normalizeIveKitEventPatterns
} from '../src/agent-runtime/converact/integration-events/catalog.js';
import {
  projectIveKitIntegrationEvent,
  runIveKitEventWebhookBatch
} from '../src/agent-runtime/converact/integration-events/worker.js';
import type {
  IveKitEventWebhookSubscription,
  IveKitStoredIntegrationEvent,
  IveKitWebhookDeliveryEnvelope
} from '../src/agent-runtime/converact/integration-events/types.js';
import {
  verifyIveKitWebhook,
  type IveKitWebhookReplayClaim
} from '../sdk/converact/src/webhook.js';

const REQUIRED_EVENT_PATHS = [
  '/api/ivekit/events',
  '/api/ivekit/events/catalog',
  '/api/ivekit/events/webhook-subscriptions'
] as const;

export async function runIveKitV5ControlledAcceptance(input: {
  source_commit: string;
  output_dir: string;
  generated_at?: string;
}): Promise<{ report_file: string; evidence_file: string }> {
  const sourceCommit = String(input.source_commit || '').trim().toLowerCase();
  if (!/^[a-f0-9]{40}$/.test(sourceCommit)) throw new Error('full source commit is required');
  const generatedAt = new Date(input.generated_at || new Date()).toISOString();
  const outputDir = resolve(input.output_dir);
  if (existsSync(outputDir) && readdirSync(outputDir).length) {
    throw new Error('controlled acceptance output directory must be empty');
  }
  const evidenceDir = resolve(outputDir, 'evidence');
  mkdirSync(evidenceDir, { recursive: true });

  const businessRef = { type: 'service_order', id: 'LED-CONTROLLED-1' };
  const eventTypes = [
    'collaboration.message.created',
    'collaboration.file.security_updated',
    'collaboration.quality_review.completed',
    'ivekit.media.call.updated',
    'remote.session.updated',
    'ivekit.voice.call.updated',
    'notification.created'
  ];
  const events = eventTypes.map((eventType, index): IveKitStoredIntegrationEvent => ({
    id: String(index + 1),
    tenant_id: 'tenant-controlled',
    event_type: eventType,
    visibility_scope: 'tenant',
    visibility_ref_id: '',
    audience_user_ids: [],
    payload: {
      business_ref: businessRef,
      resource_id: `controlled-${index + 1}`,
      state: 'accepted'
    },
    occurred_at: new Date(Date.parse(generatedAt) - 1_000 + index).toISOString(),
    expires_at: new Date(Date.parse(generatedAt) + 86_400_000).toISOString()
  }));
  const subscription = controlledSubscription(generatedAt);
  let completedCursor = '';
  const projected: ReturnType<typeof projectIveKitIntegrationEvent>[] = [];
  const summary = await runIveKitEventWebhookBatch({
    repository: {
      listWorkerTenants: async () => ['tenant-controlled'],
      claimDue: async () => [subscription],
      listEvents: async () => events,
      completeClaim: async (claim) => {
        completedCursor = claim.last_event_id;
        return { ...subscription, last_event_id: claim.last_event_id };
      },
      failClaim: async () => { throw new Error('controlled bridge unexpectedly failed'); }
    },
    config: {
      enabled: true, interval_ms: 5_000, tenant_limit: 10, subscription_limit: 10,
      event_batch_size: 100, lease_ms: 60_000, retry_delays_ms: [5_000]
    },
    worker_id: 'controlled-worker',
    now: new Date(generatedAt),
    project: async (_claim, event) => { projected.push(projectIveKitIntegrationEvent(event)); }
  });

  const inner = projected[0];
  const delivery: IveKitWebhookDeliveryEnvelope = {
    id: 'controlled-delivery-1',
    event: inner.event_type,
    tenant_id: inner.tenant_id,
    timestamp: generatedAt,
    business_ref: inner.business_ref || { type: 'ivekit_event', id: inner.event_id },
    data: inner
  };
  const rawBody = JSON.stringify(delivery);
  const secret = 'controlled-webhook-secret-32-byte';
  const timestamp = String(Math.floor(Date.parse(generatedAt) / 1_000));
  const signature = `v1=${createHmac('sha256', secret)
    .update(`${timestamp}.${rawBody}`).digest('hex')}`;
  const claims = new Map<string, IveKitWebhookReplayClaim>();
  const replayStore = {
    async claim(claim: IveKitWebhookReplayClaim): Promise<boolean> {
      if (claims.has(claim.key)) return false;
      claims.set(claim.key, claim);
      return true;
    }
  };
  const first = await verifyIveKitWebhook({
    rawBody, timestamp, signature, secret, replayStore, now: new Date(generatedAt)
  });
  const duplicate = await verifyIveKitWebhook({
    rawBody, timestamp, signature, secret, replayStore, now: new Date(generatedAt)
  });

  const openapi = String(await import('node:fs/promises').then(({ readFile }) =>
    readFile(resolve('docs/openapi.yaml'), 'utf8')
  ));
  const checks = {
    catalog_families: IVEKIT_INTEGRATION_EVENT_CATALOG.families.length === 8,
    event_domains: eventTypes.length === 7 && new Set(eventTypes).size === 7,
    business_reference: projected.every((event) =>
      event.business_ref?.type === businessRef.type && event.business_ref.id === businessRef.id),
    bridge_projection: summary.projected === events.length && summary.failed === 0,
    cursor_advance: completedCursor === events.at(-1)?.id,
    signature_verification: !first.duplicate && first.envelope.data.event_id === '1',
    durable_replay_claim: duplicate.duplicate && claims.size === 1,
    openapi_contract: REQUIRED_EVENT_PATHS.every((path) => openapi.includes(`  ${path}:`))
  };
  if (Object.values(checks).some((passed) => !passed)) {
    throw new Error(`controlled acceptance failed: ${JSON.stringify(checks)}`);
  }

  const evidence = {
    schema_version: 1,
    product: 'iveKit',
    foundation_version: 'V5',
    environment_class: 'controlled',
    source_commit: sourceCommit,
    generated_at: generatedAt,
    business_ref: businessRef,
    event_types: eventTypes,
    projected_event_ids: projected.map((event) => event.event_id),
    completed_cursor: completedCursor,
    bridge_summary: summary,
    webhook: {
      delivery_id: delivery.id,
      event_id: inner.event_id,
      body_sha256: createHash('sha256').update(rawBody).digest('hex'),
      duplicate_rejected: duplicate.duplicate,
      durable_claims: claims.size
    },
    checks,
    real_environment_evidence: false
  };
  const evidenceFile = resolve(evidenceDir, 'full-chain.json');
  writeFileSync(evidenceFile, `${JSON.stringify(evidence, null, 2)}\n`, 'utf8');
  const evidenceBytes = statSync(evidenceFile).size;
  const evidenceHash = createHash('sha256').update(
    await import('node:fs/promises').then(({ readFile }) => readFile(evidenceFile))
  ).digest('hex');
  const report = {
    schema_version: 1,
    product: 'iveKit',
    source_commit: sourceCommit,
    controlled_tests_are_real_vendor_evidence: false,
    controlled_environment: {
      postgres: { status: 'not_run', evidence: [] },
      provider_protocol: { status: 'not_run', evidence: [] },
      browser: { status: 'not_run', evidence: [] },
      restart_recovery: { status: 'not_run', evidence: [] },
      full_chain: { status: 'passed', evidence: ['full-chain.json'] }
    },
    evidence: [{ path: 'full-chain.json', bytes: evidenceBytes, sha256: evidenceHash }]
  };
  const reportFile = resolve(outputDir, 'report.json');
  writeFileSync(reportFile, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  return { report_file: reportFile, evidence_file: evidenceFile };
}

function controlledSubscription(now: string): IveKitEventWebhookSubscription {
  const patterns = normalizeIveKitEventPatterns(
    IVEKIT_INTEGRATION_EVENT_CATALOG.families.flatMap((family) => family.patterns)
  );
  return {
    id: 'subscription-controlled', tenant_id: 'tenant-controlled', endpoint_id: 'endpoint-controlled',
    name: 'Controlled full chain', event_patterns: patterns, status: 'active', last_event_id: '0',
    next_attempt_at: now, attempt_count: 0, error_code: '', lease_token_hash: 'a'.repeat(64),
    lease_until: now, worker_id: 'controlled-worker', revision: 1,
    idempotency_key: 'controlled-full-chain', payload_hash: 'b'.repeat(64),
    created_by: 'controlled', updated_by: 'controlled', created_at: now, updated_at: now
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const sourceCommit = resolveFabricEnv(process.env, 'ACCEPTANCE_SOURCE_COMMIT') || '';
  const outputDir = resolveFabricEnv(process.env, 'V5_CONTROLLED_ACCEPTANCE_DIR') ||
    resolve('.tmp/ivekit-v5-controlled-acceptance');
  await runIveKitV5ControlledAcceptance({
    source_commit: sourceCommit,
    output_dir: outputDir,
    generated_at: resolveFabricEnv(process.env, 'ACCEPTANCE_GENERATED_AT')
  });
}
