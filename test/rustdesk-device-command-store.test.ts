import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { QueryResult, QueryResultRow } from 'pg';

import { RustDeskDeviceCommandStore } from '../src/agent-runtime/collaboration/rustdesk-device-command-store.js';
import { RustDeskDeviceStore } from '../src/agent-runtime/collaboration/rustdesk-device-store.js';
import { RustDeskGatewaySessionStore } from '../src/agent-runtime/collaboration/rustdesk-gateway-session-store.js';
import { MemoryPg, type PgQueryable } from '../src/db-pg.js';

const commandTimestampFields = [
  'lease_expires_at',
  'next_attempt_at',
  'requested_at',
  'started_at',
  'completed_at',
  'updated_at'
] as const;

class DateReturningPg implements PgQueryable {
  constructor(private readonly delegate: PgQueryable) {}

  async query<R extends QueryResultRow = QueryResultRow>(
    text: string,
    params?: unknown[]
  ): Promise<QueryResult<R>> {
    const result = await this.delegate.query<R>(text, params);
    if (!text.includes('rustdesk_device_commands')) return result;
    return {
      ...result,
      rows: result.rows.map((row) => {
        const mapped = { ...row } as QueryResultRow;
        for (const field of commandTimestampFields) {
          if (mapped[field]) mapped[field] = new Date(String(mapped[field]));
        }
        return mapped as R;
      })
    };
  }
}

async function commandFixture(tenantId = 'tenant_rustdesk_commands') {
  const pg = new MemoryPg();
  const devices = new RustDeskDeviceStore(pg);
  const sessions = new RustDeskGatewaySessionStore(pg);
  const commands = new RustDeskDeviceCommandStore(pg);
  const device = await devices.registerDevice({
    tenant_id: tenantId,
    business_ref: {
      tenant_id: tenantId,
      type: 'service_order',
      id: 'SO-RUSTDESK-COMMAND-1'
    },
    rustdesk_id: '123456789',
    display_name: 'LED command target'
  });
  const session = await sessions.createSession({
    tenant_id: tenantId,
    target: {
      type: 'device',
      id: device.rustdesk_id,
      display_name: device.display_name
    },
    permissions: ['view_screen', 'control_mouse_keyboard'],
    actor_identity: 'agent-command-test',
    launch_url: 'https://opc.example.com/remote/rustdesk/launch?session_id=command-test',
    metadata: {
      rustdesk_device_id: device.id,
      rustdesk_id: device.rustdesk_id
    }
  });
  return { pg, devices, sessions, commands, device, session, tenantId };
}

test('RustDeskDeviceCommandStore enqueues one tenant-scoped disconnect command', async () => {
  const fixture = await commandFixture();
  const first = await fixture.commands.enqueueDisconnect({
    tenant_id: fixture.tenantId,
    device_id: fixture.device.id,
    external_id: fixture.session.external_id,
    requested_by: 'customer-command-test',
    requested_reason: 'consent_revoked'
  });
  const duplicate = await fixture.commands.enqueueDisconnect({
    tenant_id: fixture.tenantId,
    device_id: fixture.device.id,
    external_id: fixture.session.external_id,
    requested_by: 'agent-retry',
    requested_reason: 'gateway_ended'
  });
  const fetched = await fixture.commands.getByExternalId({
    tenant_id: fixture.tenantId,
    external_id: fixture.session.external_id
  });
  const crossTenant = await fixture.commands.getByExternalId({
    tenant_id: 'tenant_rustdesk_commands_other',
    external_id: fixture.session.external_id
  });

  assert.equal(first.command_type, 'disconnect_session');
  assert.equal(first.status, 'pending');
  assert.equal(first.attempt_count, 0);
  assert.equal(first.max_attempts, 3);
  assert.equal(duplicate.id, first.id);
  assert.equal(duplicate.requested_by, 'customer-command-test');
  assert.equal(duplicate.requested_reason, 'consent_revoked');
  assert.equal(fetched?.id, first.id);
  assert.equal(crossTenant, null);
});

test('RustDeskDeviceCommandStore leases one command and reclaims it after expiry', async () => {
  const fixture = await commandFixture('tenant_rustdesk_command_claim');
  await fixture.commands.enqueueDisconnect({
    tenant_id: fixture.tenantId,
    device_id: fixture.device.id,
    external_id: fixture.session.external_id,
    requested_by: 'customer-command-claim',
    requested_reason: 'consent_revoked'
  });

  const firstClaim = await fixture.commands.claimNext({
    tenant_id: fixture.tenantId,
    device_id: fixture.device.id,
    edge_instance_id: 'edge-command-a',
    lease_ms: 30_000,
    now: '2026-07-10T12:00:00.000Z'
  });
  const activeLeaseClaim = await fixture.commands.claimNext({
    tenant_id: fixture.tenantId,
    device_id: fixture.device.id,
    edge_instance_id: 'edge-command-b',
    lease_ms: 30_000,
    now: '2026-07-10T12:00:01.000Z'
  });
  const crossTenantClaim = await fixture.commands.claimNext({
    tenant_id: 'tenant_rustdesk_command_claim_other',
    device_id: fixture.device.id,
    edge_instance_id: 'edge-command-other',
    lease_ms: 30_000,
    now: '2026-07-10T12:00:31.000Z'
  });
  const reclaimed = await fixture.commands.claimNext({
    tenant_id: fixture.tenantId,
    device_id: fixture.device.id,
    edge_instance_id: 'edge-command-b',
    lease_ms: 30_000,
    now: '2026-07-10T12:00:31.000Z'
  });

  assert.equal(firstClaim?.command.status, 'claimed');
  assert.equal(firstClaim?.command.attempt_count, 1);
  assert.equal(firstClaim?.command.claimed_by, 'edge-command-a');
  assert.equal(firstClaim?.command.lease_expires_at, '2026-07-10T12:00:30.000Z');
  assert.equal(typeof firstClaim?.claim_token, 'string');
  assert.equal(activeLeaseClaim, null);
  assert.equal(crossTenantClaim, null);
  assert.equal(reclaimed?.command.attempt_count, 2);
  assert.equal(reclaimed?.command.claimed_by, 'edge-command-b');
  assert.notEqual(reclaimed?.claim_token, firstClaim?.claim_token);
});

test('RustDeskDeviceCommandStore recovers an executed attempt without incrementing or re-executing', async () => {
  const fixture = await commandFixture('tenant_rustdesk_command_recovery');
  const command = await fixture.commands.enqueueDisconnect({
    tenant_id: fixture.tenantId,
    device_id: fixture.device.id,
    external_id: fixture.session.external_id,
    requested_by: 'customer-command-recovery',
    requested_reason: 'consent_revoked'
  });
  const claim = (await fixture.commands.claimNext({
    tenant_id: fixture.tenantId,
    device_id: fixture.device.id,
    edge_instance_id: 'edge-command-recovery',
    lease_ms: 1_000,
    now: '2026-07-10T12:00:00.000Z'
  }))!;

  const recovered = await fixture.commands.recover({
    tenant_id: fixture.tenantId,
    device_id: fixture.device.id,
    command_id: command.id,
    edge_instance_id: 'edge-command-recovery',
    attempt: 1,
    state: 'executed',
    lease_ms: 30_000,
    now: '2026-07-10T12:00:05.000Z'
  });

  assert.equal(recovered.action, 'resume_report');
  assert.equal(recovered.command.attempt_count, 1);
  assert.equal(recovered.command.lease_expires_at, '2026-07-10T12:00:35.000Z');
  assert.notEqual(recovered.claim_token, claim.claim_token);
  const completed = await fixture.commands.complete({
    tenant_id: fixture.tenantId,
    device_id: fixture.device.id,
    command_id: command.id,
    claim_token: recovered.claim_token!,
    status: 'succeeded',
    execution_method: 'session_adapter',
    exit_code: 0,
    duration_ms: 20,
    stdout_bytes: 0,
    stderr_bytes: 0,
    metadata: { os: 'linux', edge_instance_id: 'edge-command-recovery' },
    now: '2026-07-10T12:00:05.100Z'
  });
  assert.equal(completed.status, 'succeeded');
  const terminal = await fixture.commands.recover({
    tenant_id: fixture.tenantId,
    device_id: fixture.device.id,
    command_id: command.id,
    edge_instance_id: 'edge-command-recovery',
    attempt: 1,
    state: 'executed',
    lease_ms: 30_000,
    result: {
      status: 'succeeded',
      execution_method: 'session_adapter',
      exit_code: 0,
      duration_ms: 20,
      stdout_bytes: 0,
      stderr_bytes: 0,
      metadata: { edge_instance_id: 'edge-command-recovery', os: 'linux' }
    },
    now: '2026-07-10T12:00:06.000Z'
  });
  assert.equal(terminal.action, 'terminal');
  assert.equal(terminal.result_matches, true);
});

test('RustDeskDeviceCommandStore terminalizes uncertain executing recovery without retry', async () => {
  const fixture = await commandFixture('tenant_rustdesk_command_uncertain');
  const command = await fixture.commands.enqueueDisconnect({
    tenant_id: fixture.tenantId,
    device_id: fixture.device.id,
    external_id: fixture.session.external_id,
    requested_by: 'customer-command-uncertain',
    requested_reason: 'consent_revoked'
  });
  await fixture.commands.claimNext({
    tenant_id: fixture.tenantId,
    device_id: fixture.device.id,
    edge_instance_id: 'edge-command-uncertain',
    lease_ms: 1_000,
    now: '2026-07-10T12:00:00.000Z'
  });

  const recovered = await fixture.commands.recover({
    tenant_id: fixture.tenantId,
    device_id: fixture.device.id,
    command_id: command.id,
    edge_instance_id: 'edge-command-uncertain',
    attempt: 1,
    state: 'executing',
    lease_ms: 30_000,
    now: '2026-07-10T12:00:05.000Z'
  });

  assert.equal(recovered.action, 'quarantine');
  assert.equal(recovered.command.status, 'failed');
  assert.equal(recovered.command.result_metadata.error_code, 'edge_recovery_execution_uncertain');
  assert.equal(await fixture.commands.claimNext({
    tenant_id: fixture.tenantId,
    device_id: fixture.device.id,
    edge_instance_id: 'edge-command-after-uncertain',
    lease_ms: 30_000,
    now: '2026-07-10T12:00:06.000Z'
  }), null);
});

test('RustDeskDeviceCommandStore refuses recovery owned by another edge attempt', async () => {
  const fixture = await commandFixture('tenant_rustdesk_command_recovery_owner');
  const command = await fixture.commands.enqueueDisconnect({
    tenant_id: fixture.tenantId,
    device_id: fixture.device.id,
    external_id: fixture.session.external_id,
    requested_by: 'customer-command-owner',
    requested_reason: 'consent_revoked'
  });
  await fixture.commands.claimNext({
    tenant_id: fixture.tenantId,
    device_id: fixture.device.id,
    edge_instance_id: 'edge-command-owner-a',
    lease_ms: 1_000,
    now: '2026-07-10T12:00:00.000Z'
  });
  await fixture.commands.claimNext({
    tenant_id: fixture.tenantId,
    device_id: fixture.device.id,
    edge_instance_id: 'edge-command-owner-b',
    lease_ms: 30_000,
    now: '2026-07-10T12:00:02.000Z'
  });

  const recovered = await fixture.commands.recover({
    tenant_id: fixture.tenantId,
    device_id: fixture.device.id,
    command_id: command.id,
    edge_instance_id: 'edge-command-owner-a',
    attempt: 1,
    state: 'executed',
    lease_ms: 30_000,
    now: '2026-07-10T12:00:03.000Z'
  });
  assert.equal(recovered.action, 'quarantine');
  assert.equal(recovered.command.claimed_by, 'edge-command-owner-b');
  assert.equal(recovered.command.attempt_count, 2);
});

test('RustDeskDeviceCommandStore validates command claim inputs', async () => {
  const fixture = await commandFixture('tenant_rustdesk_command_claim_invalid');

  await assert.rejects(
    () => fixture.commands.claimNext({
      tenant_id: fixture.tenantId,
      device_id: fixture.device.id,
      edge_instance_id: 'edge-command-invalid',
      lease_ms: 999
    }),
    /lease_ms must be an integer from 1000 to 300000/
  );
  await assert.rejects(
    () => fixture.commands.claimNext({
      tenant_id: fixture.tenantId,
      device_id: fixture.device.id,
      edge_instance_id: ' ',
      lease_ms: 30_000
    }),
    /edge_instance_id is required/
  );
  await assert.rejects(
    () => fixture.commands.claimNext({
      tenant_id: fixture.tenantId,
      device_id: fixture.device.id,
      edge_instance_id: 'edge-command-invalid-time',
      lease_ms: 30_000,
      now: 'not-a-time'
    }),
    /now must be an ISO timestamp/
  );
});

test('RustDeskDeviceCommandStore treats pg Date leases as timestamps', async () => {
  const fixture = await commandFixture('tenant_rustdesk_command_pg_dates');
  const command = await fixture.commands.enqueueDisconnect({
    tenant_id: fixture.tenantId,
    device_id: fixture.device.id,
    external_id: fixture.session.external_id,
    requested_by: 'customer-command-pg-dates',
    requested_reason: 'consent_revoked'
  });
  const claim = await fixture.commands.claimNext({
    tenant_id: fixture.tenantId,
    device_id: fixture.device.id,
    edge_instance_id: 'edge-command-pg-dates',
    lease_ms: 1_000,
    now: '2026-07-10T12:00:00.000Z'
  });
  assert.ok(claim);

  const dateReturningCommands = new RustDeskDeviceCommandStore(new DateReturningPg(fixture.pg));
  const fetched = await dateReturningCommands.getByExternalId({
    tenant_id: fixture.tenantId,
    external_id: fixture.session.external_id
  });
  assert.equal(fetched?.lease_expires_at, '2026-07-10T12:00:01.000Z');
  await assert.rejects(
    () => dateReturningCommands.recordProgress({
      tenant_id: fixture.tenantId,
      device_id: fixture.device.id,
      command_id: command.id,
      claim_token: claim.claim_token,
      progress: 'fallback_started',
      now: '2026-07-10T12:00:02.000Z'
    }),
    /command claim token is invalid or expired/
  );
});

test('RustDeskDeviceCommandStore terminalizes an exhausted expired claim', async () => {
  const fixture = await commandFixture('tenant_rustdesk_command_expired_final');
  const command = await fixture.commands.enqueueDisconnect({
    tenant_id: fixture.tenantId,
    device_id: fixture.device.id,
    external_id: fixture.session.external_id,
    requested_by: 'customer-command-expired-final',
    requested_reason: 'consent_revoked'
  });

  for (const now of [
    '2026-07-10T12:00:00.000Z',
    '2026-07-10T12:00:01.000Z',
    '2026-07-10T12:00:02.000Z'
  ]) {
    const claim = await fixture.commands.claimNext({
      tenant_id: fixture.tenantId,
      device_id: fixture.device.id,
      edge_instance_id: 'edge-command-expired-final',
      lease_ms: 1_000,
      now
    });
    assert.ok(claim);
  }

  const terminal = await fixture.commands.getByExternalId({
    tenant_id: fixture.tenantId,
    external_id: fixture.session.external_id,
    now: '2026-07-10T12:00:03.000Z'
  });

  assert.equal(terminal?.id, command.id);
  assert.equal(terminal?.status, 'failed');
  assert.equal(terminal?.completed_at, '2026-07-10T12:00:03.000Z');
  assert.equal(terminal?.lease_expires_at, null);
  assert.equal(terminal?.result_metadata.error_code, 'claim_lease_expired');
  const events = await fixture.sessions.listAuditEvents({ external_id: fixture.session.external_id });
  assert.equal(
    events?.filter((event) => event.event_type === 'remote.rustdesk.disconnect.failed').length,
    1
  );
});

test('RustDeskDeviceCommandStore retries failed attempts and makes the third failure terminal', async () => {
  const fixture = await commandFixture('tenant_rustdesk_command_retry');
  const command = await fixture.commands.enqueueDisconnect({
    tenant_id: fixture.tenantId,
    device_id: fixture.device.id,
    external_id: fixture.session.external_id,
    requested_by: 'customer-command-retry',
    requested_reason: 'consent_revoked'
  });
  const firstClaim = (await fixture.commands.claimNext({
    tenant_id: fixture.tenantId,
    device_id: fixture.device.id,
    edge_instance_id: 'edge-command-retry-a',
    lease_ms: 30_000,
    now: '2026-07-10T12:00:00.000Z'
  }))!;

  await assert.rejects(
    () => fixture.commands.complete({
      tenant_id: fixture.tenantId,
      device_id: fixture.device.id,
      command_id: command.id,
      claim_token: 'wrong-token',
      status: 'failed',
      execution_method: 'service_restart',
      exit_code: 1,
      duration_ms: 80,
      now: '2026-07-10T12:00:00.100Z'
    }),
    /command claim token is invalid or expired/
  );
  await fixture.commands.recordProgress({
    tenant_id: fixture.tenantId,
    device_id: fixture.device.id,
    command_id: command.id,
    claim_token: firstClaim.claim_token,
    progress: 'session_adapter_failed',
    exit_code: 1,
    duration_ms: 25,
    metadata: { fallback_reason: 'adapter_exit_nonzero' },
    now: '2026-07-10T12:00:00.100Z'
  });
  await fixture.commands.recordProgress({
    tenant_id: fixture.tenantId,
    device_id: fixture.device.id,
    command_id: command.id,
    claim_token: firstClaim.claim_token,
    progress: 'fallback_started',
    metadata: { collateral_sessions_may_disconnect: true },
    now: '2026-07-10T12:00:00.200Z'
  });
  const firstFailure = await fixture.commands.complete({
    tenant_id: fixture.tenantId,
    device_id: fixture.device.id,
    command_id: command.id,
    claim_token: firstClaim.claim_token,
    status: 'failed',
    execution_method: 'service_restart',
    exit_code: 1,
    duration_ms: 80,
    stdout_bytes: 0,
    stderr_bytes: 14,
    stderr_sha256: `sha256:${'a'.repeat(64)}`,
    metadata: { edge_agent_version: '1.0.0', os: 'windows' },
    now: '2026-07-10T12:00:00.300Z'
  });
  assert.equal(firstFailure.status, 'pending');
  assert.equal(firstFailure.next_attempt_at, '2026-07-10T12:00:02.300Z');
  assert.equal(await fixture.commands.claimNext({
    tenant_id: fixture.tenantId,
    device_id: fixture.device.id,
    edge_instance_id: 'edge-command-retry-early',
    lease_ms: 30_000,
    now: '2026-07-10T12:00:02.299Z'
  }), null);

  const secondClaim = (await fixture.commands.claimNext({
    tenant_id: fixture.tenantId,
    device_id: fixture.device.id,
    edge_instance_id: 'edge-command-retry-b',
    lease_ms: 30_000,
    now: '2026-07-10T12:00:02.300Z'
  }))!;
  const secondFailure = await fixture.commands.complete({
    tenant_id: fixture.tenantId,
    device_id: fixture.device.id,
    command_id: command.id,
    claim_token: secondClaim.claim_token,
    status: 'failed',
    execution_method: 'service_restart',
    exit_code: 1,
    duration_ms: 90,
    now: '2026-07-10T12:00:02.400Z'
  });
  assert.equal(secondFailure.status, 'pending');
  assert.equal(secondFailure.next_attempt_at, '2026-07-10T12:00:12.400Z');

  const thirdClaim = (await fixture.commands.claimNext({
    tenant_id: fixture.tenantId,
    device_id: fixture.device.id,
    edge_instance_id: 'edge-command-retry-c',
    lease_ms: 30_000,
    now: '2026-07-10T12:00:12.400Z'
  }))!;
  const finalFailureInput = {
    tenant_id: fixture.tenantId,
    device_id: fixture.device.id,
    command_id: command.id,
    claim_token: thirdClaim.claim_token,
    status: 'failed' as const,
    execution_method: 'service_restart' as const,
    exit_code: 1,
    duration_ms: 100,
    metadata: { collateral_sessions_may_disconnect: true },
    now: '2026-07-10T12:00:12.500Z'
  };
  const finalFailure = await fixture.commands.complete(finalFailureInput);
  const repeatedFinalFailure = await fixture.commands.complete(finalFailureInput);

  assert.equal(finalFailure.status, 'failed');
  assert.equal(finalFailure.completed_at, '2026-07-10T12:00:12.500Z');
  assert.equal(repeatedFinalFailure.id, finalFailure.id);
  await assert.rejects(
    () => fixture.commands.complete({
      ...finalFailureInput,
      status: 'succeeded'
    }),
    /rustdesk command is already completed with a different result/
  );
  assert.equal(await fixture.commands.claimNext({
    tenant_id: fixture.tenantId,
    device_id: fixture.device.id,
    edge_instance_id: 'edge-command-retry-after-final',
    lease_ms: 30_000,
    now: '2026-07-10T12:01:00.000Z'
  }), null);

  const events = await fixture.sessions.listAuditEvents({ external_id: fixture.session.external_id });
  const disconnectEvents = events?.filter((event) => event.event_type.startsWith('remote.rustdesk.disconnect.')) || [];
  assert.deepEqual(disconnectEvents.map((event) => event.event_type), [
    'remote.rustdesk.disconnect.requested',
    'remote.rustdesk.disconnect.claimed',
    'remote.rustdesk.disconnect.session_adapter_failed',
    'remote.rustdesk.disconnect.fallback_started',
    'remote.rustdesk.disconnect.claimed',
    'remote.rustdesk.disconnect.claimed',
    'remote.rustdesk.disconnect.failed'
  ]);
});

test('RustDeskDeviceCommandStore completes success idempotently and protects result metadata', async () => {
  const fixture = await commandFixture('tenant_rustdesk_command_success');
  const command = await fixture.commands.enqueueDisconnect({
    tenant_id: fixture.tenantId,
    device_id: fixture.device.id,
    external_id: fixture.session.external_id,
    requested_by: 'agent-command-success',
    requested_reason: 'gateway_ended'
  });
  const claim = (await fixture.commands.claimNext({
    tenant_id: fixture.tenantId,
    device_id: fixture.device.id,
    edge_instance_id: 'edge-command-success',
    lease_ms: 30_000,
    now: '2026-07-10T13:00:00.000Z'
  }))!;

  await assert.rejects(
    () => fixture.commands.complete({
      tenant_id: fixture.tenantId,
      device_id: fixture.device.id,
      command_id: command.id,
      claim_token: claim.claim_token,
      status: 'succeeded',
      execution_method: 'session_adapter',
      exit_code: 0,
      duration_ms: 40,
      metadata: { raw_stdout: 'secret output' },
      now: '2026-07-10T13:00:00.100Z'
    }),
    /unsupported rustdesk command metadata field: raw_stdout/
  );
  await assert.rejects(
    () => fixture.commands.complete({
      tenant_id: fixture.tenantId,
      device_id: fixture.device.id,
      command_id: command.id,
      claim_token: claim.claim_token,
      status: 'succeeded',
      execution_method: 'session_adapter',
      metadata: { edge_agent_version: 'x'.repeat(65) },
      now: '2026-07-10T13:00:00.100Z'
    }),
    /metadata.edge_agent_version/
  );
  await assert.rejects(
    () => fixture.commands.complete({
      tenant_id: fixture.tenantId,
      device_id: fixture.device.id,
      command_id: command.id,
      claim_token: claim.claim_token,
      status: 'succeeded',
      execution_method: 'session_adapter',
      metadata: { os: 'api-key-secret-value' },
      now: '2026-07-10T13:00:00.100Z'
    }),
    /metadata.os must be a supported operating system/
  );
  await assert.rejects(
    () => fixture.commands.complete({
      tenant_id: fixture.tenantId,
      device_id: fixture.device.id,
      command_id: command.id,
      claim_token: claim.claim_token,
      status: 'succeeded',
      execution_method: 'session_adapter',
      metadata: { collateral_sessions_may_disconnect: 'true' },
      now: '2026-07-10T13:00:00.100Z'
    }),
    /metadata.collateral_sessions_may_disconnect must be a boolean/
  );

  const successInput = {
    tenant_id: fixture.tenantId,
    device_id: fixture.device.id,
    command_id: command.id,
    claim_token: claim.claim_token,
    status: 'succeeded' as const,
    execution_method: 'session_adapter' as const,
    exit_code: 0,
    duration_ms: 40,
    stdout_bytes: 2,
    stderr_bytes: 0,
    stdout_sha256: `sha256:${'b'.repeat(64)}`,
    metadata: { edge_agent_version: '1.0.0', os: 'linux' },
    now: '2026-07-10T13:00:00.100Z'
  };
  const success = await fixture.commands.complete(successInput);
  const repeated = await fixture.commands.complete(successInput);

  assert.equal(success.status, 'succeeded');
  assert.equal(success.execution_method, 'session_adapter');
  assert.equal(success.claimed_by, 'edge-command-success');
  assert.equal(repeated.id, success.id);
  assert.equal(await fixture.commands.claimNext({
    tenant_id: fixture.tenantId,
    device_id: fixture.device.id,
    edge_instance_id: 'edge-command-success-after',
    lease_ms: 30_000,
    now: '2026-07-10T13:01:00.000Z'
  }), null);
});

test('RustDeskDeviceCommandStore accepts concurrent identical completion once', async () => {
  const fixture = await commandFixture('tenant_rustdesk_command_concurrent_result');
  const command = await fixture.commands.enqueueDisconnect({
    tenant_id: fixture.tenantId,
    device_id: fixture.device.id,
    external_id: fixture.session.external_id,
    requested_by: 'agent-command-concurrent-result',
    requested_reason: 'gateway_ended'
  });
  const claim = (await fixture.commands.claimNext({
    tenant_id: fixture.tenantId,
    device_id: fixture.device.id,
    edge_instance_id: 'edge-command-concurrent-result',
    lease_ms: 30_000,
    now: '2026-07-10T14:00:00.000Z'
  }))!;
  const input = {
    tenant_id: fixture.tenantId,
    device_id: fixture.device.id,
    command_id: command.id,
    claim_token: claim.claim_token,
    status: 'succeeded' as const,
    execution_method: 'session_adapter' as const,
    exit_code: 0,
    duration_ms: 40,
    stdout_bytes: 0,
    stderr_bytes: 0,
    metadata: { edge_agent_version: '1.0.0', os: 'linux' },
    now: '2026-07-10T14:00:00.100Z'
  };

  const completed = await Promise.all([
    fixture.commands.complete(input),
    fixture.commands.complete(input)
  ]);
  const events = await fixture.sessions.listAuditEvents({ external_id: fixture.session.external_id });

  assert.deepEqual(completed.map((item) => item.status), ['succeeded', 'succeeded']);
  assert.equal(
    events?.filter((event) => event.event_type === 'remote.rustdesk.disconnect.succeeded').length,
    1
  );
});
