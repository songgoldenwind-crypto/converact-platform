import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import {
  executeRustDeskDisconnectCommand,
  RustDeskEdgeCommandProcessor,
  type RustDeskEdgeClaimCommand,
  type RustDeskEdgeCommandProgressReport
} from '../scripts/rustdesk-edge-command.js';
import { RustDeskOwnerEpochFence } from '../scripts/rustdesk-owner-epoch-fence.js';

const command: RustDeskEdgeClaimCommand = {
  id: 'rdcmd_edge_execution_1',
  command_type: 'disconnect_session',
  external_id: 'rdgw_edge_execution_1',
  target_id: 'rdesk_edge_execution_1',
  rustdesk_id: '123456789',
  controller_rustdesk_id: '987654321',
  requested_reason: 'consent_revoked',
  attempt: 1,
  lease_expires_at: '2099-01-01T00:00:00.000Z',
  emergency_fallback_authorized: false,
  emergency_fallback_reason: ''
};

const epochCommand: RustDeskEdgeClaimCommand = {
  ...command,
  id: 'rdcmd_edge_epoch_1',
  external_id: 'rdgw_edge_epoch_1',
  native_control_protocol: 'ivekit-rustdesk-native-control-v2',
  interaction_id: 'remote-session-edge-epoch-1',
  reservation_id: 'reservation-edge-epoch-1',
  owner_epoch: '17'
};

test('edge command executes the primary adapter with fixed args and server identifiers in env', async () => {
  const progress: RustDeskEdgeCommandProgressReport[] = [];
  const result = await executeRustDeskDisconnectCommand(
    command,
    {
      timeoutMs: 2_000,
      edgeInstanceId: 'edge-execution-primary',
      edgeAgentVersion: '1.0.0',
      os: process.platform,
      disconnectAdapter: {
        executable: process.execPath,
        args: [
          '-e',
          `const ok =
            process.env.OPC_RUSTDESK_COMMAND_ID === 'rdcmd_edge_execution_1' &&
            process.env.OPC_RUSTDESK_EXTERNAL_ID === 'rdgw_edge_execution_1' &&
            process.env.OPC_RUSTDESK_TARGET_ID === 'rdesk_edge_execution_1' &&
            process.env.OPC_RUSTDESK_RUSTDESK_ID === '123456789' &&
            process.env.OPC_RUSTDESK_CONTROLLER_RUSTDESK_ID === '987654321' &&
            process.env.OPC_RUSTDESK_DISCONNECT_REASON === 'consent_revoked';
           process.stdout.write('primary-adapter-output');
           process.exit(ok ? 0 : 9);`
        ]
      },
      restartAdapter: {
        executable: process.execPath,
        args: ['-e', 'process.exit(7)']
      }
    },
    async (report) => {
      progress.push(report);
    }
  );

  assert.equal(result.status, 'succeeded');
  assert.equal(result.execution_method, 'session_adapter');
  assert.equal(result.exit_code, 0);
  assert.equal(result.stdout_bytes, Buffer.byteLength('primary-adapter-output'));
  assert.match(result.stdout_sha256, /^sha256:[a-f0-9]{64}$/);
  assert.equal(result.stderr_bytes, 0);
  assert.equal(result.metadata.edge_instance_id, 'edge-execution-primary');
  assert.equal(result.metadata.edge_agent_version, '1.0.0');
  assert.equal('stdout' in result, false);
  assert.equal('stderr' in result, false);
  assert.deepEqual(progress, []);
});

test('edge command expands only fixed command placeholders into argv without a shell', async () => {
  const result = await executeRustDeskDisconnectCommand(command, {
    timeoutMs: 2_000,
    edgeInstanceId: 'edge-execution-argv',
    edgeAgentVersion: '1.0.0',
    os: process.platform,
    disconnectAdapter: {
      executable: process.execPath,
      args: [
        '-e',
        `const expected = ['--external-id','rdgw_edge_execution_1','--target-id','rdesk_edge_execution_1','--rustdesk-id','123456789','--controller-rustdesk-id','987654321','--reason','consent_revoked'];
         process.exit(JSON.stringify(process.argv.slice(1)) === JSON.stringify(expected) ? 0 : 8);`,
        '--',
        '--external-id', '{external_id}',
        '--target-id', '{target_id}',
        '--rustdesk-id', '{rustdesk_id}',
        '--controller-rustdesk-id', '{controller_rustdesk_id}',
        '--reason', '{requested_reason}'
      ]
    },
    restartAdapter: null
  });

  assert.equal(result.status, 'succeeded');
  assert.equal(result.execution_method, 'session_adapter');
});

test('edge command carries the complete owner identity into the native adapter', async () => {
  const result = await executeRustDeskDisconnectCommand(epochCommand, {
    timeoutMs: 2_000,
    edgeInstanceId: 'edge-execution-owner-epoch',
    edgeAgentVersion: '1.0.0',
    os: process.platform,
    disconnectAdapter: {
      executable: process.execPath,
      args: [
        '-e',
        `const expected = [
          'ivekit-rustdesk-native-control-v2',
          'remote-session-edge-epoch-1',
          'reservation-edge-epoch-1',
          '17'
        ];
        const envOk =
          process.env.OPC_RUSTDESK_INTERACTION_ID === expected[1] &&
          process.env.OPC_RUSTDESK_RESERVATION_ID === expected[2] &&
          process.env.OPC_RUSTDESK_OWNER_EPOCH === expected[3];
        process.exit(
          envOk && JSON.stringify(process.argv.slice(1)) === JSON.stringify(expected) ? 0 : 8
        );`,
        '--',
        '{native_control_protocol}',
        '{interaction_id}',
        '{reservation_id}',
        '{owner_epoch}'
      ]
    },
    restartAdapter: null
  });

  assert.equal(result.status, 'succeeded');
  assert.equal(result.execution_method, 'session_adapter');
});

test('edge command rejects unknown adapter placeholders before spawning', async () => {
  await assert.rejects(
    () => executeRustDeskDisconnectCommand(command, {
      timeoutMs: 2_000,
      edgeInstanceId: 'edge-execution-bad-placeholder',
      edgeAgentVersion: '1.0.0',
      os: process.platform,
      disconnectAdapter: {
        executable: process.execPath,
        args: ['{arbitrary_server_command}']
      },
      restartAdapter: null
    }),
    /unsupported RustDesk adapter placeholder/
  );
});

test('edge command rejects unbounded or unsafe server identifiers before spawning', async () => {
  await assert.rejects(
    () => executeRustDeskDisconnectCommand({
      ...command,
      external_id: 'gateway-1\n--service=malicious'
    }, {
      timeoutMs: 2_000,
      edgeInstanceId: 'edge-execution-bad-id',
      edgeAgentVersion: '1.0.0',
      os: process.platform,
      disconnectAdapter: { executable: process.execPath, args: ['-e', 'process.exit(0)'] },
      restartAdapter: null
    }),
    /external_id contains unsupported characters or length/
  );
});

test('edge command never restarts the service after an unapproved primary failure', async () => {
  const progress: RustDeskEdgeCommandProgressReport[] = [];
  const result = await executeRustDeskDisconnectCommand(
    command,
    {
      timeoutMs: 2_000,
      edgeInstanceId: 'edge-execution-fallback',
      edgeAgentVersion: '1.0.0',
      os: process.platform,
      disconnectAdapter: {
        executable: process.execPath,
        args: ['-e', "process.stderr.write('primary failed'); process.exit(2)"]
      },
      restartAdapter: {
        executable: process.execPath,
        args: ['-e', "process.stdout.write('restart ok'); process.exit(0)"]
      }
    },
    async (report) => {
      progress.push(report);
    }
  );

  assert.equal(result.status, 'failed');
  assert.equal(result.execution_method, 'session_adapter');
  assert.equal(result.exit_code, 2);
  assert.equal(result.metadata.precise_disconnect_unavailable, true);
  assert.equal(result.metadata.emergency_fallback_authorized, false);
  assert.equal(result.metadata.fallback_reason, 'adapter_exit_nonzero');
  assert.deepEqual(progress.map((item) => item.progress), ['session_adapter_failed']);
  assert.equal(progress[0]?.exit_code, 2);
});

test('edge command runs the service restart only after explicit emergency authorization', async () => {
  const progress: RustDeskEdgeCommandProgressReport[] = [];
  const result = await executeRustDeskDisconnectCommand(
    {
      ...command,
      emergency_fallback_authorized: true,
      emergency_fallback_reason: 'incident commander approved collateral disconnect'
    },
    {
      timeoutMs: 2_000,
      edgeInstanceId: 'edge-execution-authorized-fallback',
      edgeAgentVersion: '1.0.0',
      os: process.platform,
      disconnectAdapter: {
        executable: process.execPath,
        args: ['-e', 'process.exit(20)']
      },
      restartAdapter: {
        executable: process.execPath,
        args: ['-e', "process.stdout.write('restart ok'); process.exit(0)"]
      }
    },
    async (report) => {
      progress.push(report);
    }
  );

  assert.equal(result.status, 'succeeded');
  assert.equal(result.execution_method, 'service_restart');
  assert.equal(result.metadata.collateral_sessions_may_disconnect, true);
  assert.equal(result.metadata.emergency_fallback_authorized, true);
  assert.equal(result.metadata.emergency_fallback_reason, 'incident commander approved collateral disconnect');
  assert.equal(result.metadata.fallback_reason, 'targeted_disconnect_unavailable');
  assert.deepEqual(progress.map((item) => item.progress), [
    'session_adapter_failed',
    'fallback_started'
  ]);
});

test('edge command preserves targeted-unavailable and missing-service reasons', async () => {
  const result = await executeRustDeskDisconnectCommand(command, {
    timeoutMs: 2_000,
    edgeInstanceId: 'edge-execution-unavailable',
    edgeAgentVersion: '1.0.0',
    os: process.platform,
    disconnectAdapter: {
      executable: process.execPath,
      args: ['-e', 'process.exit(20)']
    },
    restartAdapter: {
      executable: process.execPath,
      args: ['-e', 'process.exit(21)']
    }
  });

  assert.equal(result.status, 'failed');
  assert.equal(result.execution_method, 'session_adapter');
  assert.equal(result.metadata.fallback_reason, 'targeted_disconnect_unavailable');
  assert.equal(result.metadata.emergency_fallback_authorized, false);
});

test('edge command times out the primary adapter without running an unapproved fallback', async () => {
  const progress: RustDeskEdgeCommandProgressReport[] = [];
  const startedAt = Date.now();
  const result = await executeRustDeskDisconnectCommand(
    command,
    {
      timeoutMs: 100,
      edgeInstanceId: 'edge-execution-timeout',
      edgeAgentVersion: '1.0.0',
      os: process.platform,
      disconnectAdapter: {
        executable: process.execPath,
        args: ['-e', 'setTimeout(() => process.exit(0), 5000)']
      },
      restartAdapter: {
        executable: process.execPath,
        args: ['-e', 'process.exit(0)']
      }
    },
    async (report) => {
      progress.push(report);
    }
  );

  assert.equal(result.status, 'failed');
  assert.equal(result.execution_method, 'session_adapter');
  assert.equal(progress[0]?.metadata.timed_out, true);
  assert.equal(result.metadata.fallback_reason, 'adapter_timeout');
  assert.deepEqual(progress.map((item) => item.progress), ['session_adapter_failed']);
  assert.ok(Date.now() - startedAt < 3_000);
});

test('edge command force-terminates an adapter that ignores the timeout signal', async () => {
  const startedAt = Date.now();
  const result = await executeRustDeskDisconnectCommand(command, {
    timeoutMs: 200,
    edgeInstanceId: 'edge-execution-force-timeout',
    edgeAgentVersion: '1.0.0',
    os: process.platform,
    disconnectAdapter: {
      executable: process.execPath,
      args: [
        '-e',
        "process.on('SIGTERM', () => {}); setTimeout(() => process.exit(0), 2000)"
      ]
    },
    restartAdapter: {
      executable: process.execPath,
      args: ['-e', 'process.exit(0)']
    }
  });

  assert.equal(result.status, 'failed');
  assert.equal(result.execution_method, 'session_adapter');
  assert.equal(result.metadata.fallback_reason, 'adapter_timeout');
  assert.ok(Date.now() - startedAt < 1_000);
});

test('edge command reports failed when the service restart fallback fails', async () => {
  const progress: RustDeskEdgeCommandProgressReport[] = [];
  const result = await executeRustDeskDisconnectCommand(
    {
      ...command,
      emergency_fallback_authorized: true,
      emergency_fallback_reason: 'approved emergency restart after precise disconnect failed'
    },
    {
      timeoutMs: 2_000,
      edgeInstanceId: 'edge-execution-failed',
      edgeAgentVersion: '1.0.0',
      os: process.platform,
      disconnectAdapter: null,
      restartAdapter: {
        executable: process.execPath,
        args: ['-e', 'process.exit(3)']
      }
    },
    async (report) => {
      progress.push(report);
    }
  );

  assert.equal(result.status, 'failed');
  assert.equal(result.execution_method, 'service_restart');
  assert.equal(result.exit_code, 3);
  assert.equal(result.metadata.fallback_reason, 'adapter_not_configured');
  assert.deepEqual(progress.map((item) => item.progress), [
    'session_adapter_failed',
    'fallback_started'
  ]);
});

test('edge command processor returns idle when the authenticated claim API has no work', async () => {
  const calls: Array<{ method: string; path: string; edgeToken: string; authorization: string }> = [];
  const processor = new RustDeskEdgeCommandProcessor(
    {
      baseUrl: 'https://opc.example.com',
      commandToken: 'edge-command-token-idle',
      edgeInstanceId: 'edge-processor-idle',
      commandLeaseMs: 30_000,
      execution: {
        timeoutMs: 2_000,
        edgeInstanceId: 'edge-processor-idle',
        edgeAgentVersion: '1.0.0',
        os: process.platform,
        disconnectAdapter: null,
        restartAdapter: null
      }
    },
    async (input, init = {}) => {
      const url = new URL(String(input));
      const headers = init.headers as Record<string, string>;
      calls.push({
        method: init.method || 'GET',
        path: url.pathname,
        edgeToken: headers['x-rustdesk-edge-token'],
        authorization: headers.authorization || ''
      });
      return new Response(null, { status: 204 });
    }
  );

  assert.equal(await processor.pollOnce('rdesk_edge_idle'), 'idle');
  assert.deepEqual(calls, [
    {
      method: 'POST',
      path: '/api/ivekit/rustdesk/devices/rdesk_edge_idle/commands/claim',
      edgeToken: 'edge-command-token-idle',
      authorization: ''
    }
  ]);
});

test('edge command processor rejects a command above its server-bound owner before native execution', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'opc-rustdesk-edge-owner-mismatch-'));
  const executionFile = join(dataDir, 'executions.txt');
  const processor = new RustDeskEdgeCommandProcessor(
    {
      baseUrl: 'https://opc.example.com',
      commandToken: 'edge-command-token-owner-mismatch',
      edgeInstanceId: 'edge-processor-owner-mismatch',
      commandLeaseMs: 30_000,
      placementEnabled: true,
      spool: { directory: join(dataDir, 'spool') },
      execution: {
        timeoutMs: 2_000,
        edgeInstanceId: 'edge-processor-owner-mismatch',
        edgeAgentVersion: '1.0.0',
        os: process.platform,
        disconnectAdapter: {
          executable: process.execPath,
          args: [
            '-e',
            `require('node:fs').appendFileSync(${JSON.stringify(executionFile)}, 'x')`
          ]
        },
        restartAdapter: null
      }
    },
    async (input) => {
      const url = new URL(String(input));
      if (!url.pathname.endsWith('/commands/claim')) {
        return jsonResponse(500, { error: 'unexpected request' });
      }
      return jsonResponse(201, {
        command: { ...epochCommand, owner_epoch: '18' },
        owner_binding: {
          interaction_id: epochCommand.interaction_id,
          reservation_id: epochCommand.reservation_id,
          owner_epoch: epochCommand.owner_epoch
        },
        claim_token: 'claim-token-owner-mismatch'
      });
    }
  );

  try {
    await assert.rejects(
      () => processor.pollOnce(epochCommand.target_id),
      /rustdesk_owner_binding_mismatch/
    );
    assert.throws(() => readFileSync(executionFile, 'utf8'), /ENOENT/);
  } finally {
    await processor.close();
  }
});

test('edge command processor reports a persisted stale epoch without executing native control', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'opc-rustdesk-edge-owner-stale-'));
  const spoolDir = join(dataDir, 'spool');
  const executionFile = join(dataDir, 'executions.txt');
  const fence = await RustDeskOwnerEpochFence.open({ directory: spoolDir });
  await fence.accept({
    external_id: epochCommand.external_id,
    command_id: 'rdcmd-edge-owner-newer',
    interaction_id: epochCommand.interaction_id!,
    reservation_id: 'reservation-edge-epoch-newer',
    owner_epoch: '18'
  });
  await fence.close();
  const results: Array<Record<string, unknown>> = [];
  const processor = new RustDeskEdgeCommandProcessor(
    {
      baseUrl: 'https://opc.example.com',
      commandToken: 'edge-command-token-owner-stale',
      edgeInstanceId: 'edge-processor-owner-stale',
      commandLeaseMs: 30_000,
      placementEnabled: true,
      spool: { directory: spoolDir },
      execution: {
        timeoutMs: 2_000,
        edgeInstanceId: 'edge-processor-owner-stale',
        edgeAgentVersion: '1.0.0',
        os: process.platform,
        disconnectAdapter: {
          executable: process.execPath,
          args: [
            '-e',
            `require('node:fs').appendFileSync(${JSON.stringify(executionFile)}, 'x')`
          ]
        },
        restartAdapter: null
      }
    },
    async (input, init = {}) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith('/commands/claim')) {
        return jsonResponse(201, {
          command: epochCommand,
          owner_binding: {
            interaction_id: epochCommand.interaction_id,
            reservation_id: epochCommand.reservation_id,
            owner_epoch: epochCommand.owner_epoch
          },
          claim_token: 'claim-token-owner-stale'
        });
      }
      if (url.pathname.endsWith('/result')) {
        results.push(JSON.parse(String(init.body)) as Record<string, unknown>);
        return jsonResponse(201, { command: { status: 'failed' } });
      }
      return jsonResponse(500, { error: 'unexpected request' });
    }
  );

  try {
    assert.equal(await processor.pollOnce(epochCommand.target_id), 'executed');
    assert.throws(() => readFileSync(executionFile, 'utf8'), /ENOENT/);
    assert.equal(results[0].status, 'failed');
    assert.equal(
      (results[0].metadata as Record<string, unknown>).error_code,
      'stale_rustdesk_owner_epoch'
    );
  } finally {
    await processor.close();
  }
});

test('edge command processor retains and retries a failed result report without re-executing', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'opc-rustdesk-edge-command-'));
  const executionFile = join(dataDir, 'executions.txt');
  const calls: string[] = [];
  let resultAttempts = 0;
  const processor = new RustDeskEdgeCommandProcessor(
    {
      baseUrl: 'https://opc.example.com',
      commandToken: 'edge-command-token-retry',
      edgeInstanceId: 'edge-processor-retry',
      commandLeaseMs: 30_000,
      execution: {
        timeoutMs: 2_000,
        edgeInstanceId: 'edge-processor-retry',
        edgeAgentVersion: '1.0.0',
        os: process.platform,
        disconnectAdapter: {
          executable: process.execPath,
          args: [
            '-e',
            `require('node:fs').appendFileSync(${JSON.stringify(executionFile)}, 'x')`
          ]
        },
        restartAdapter: null
      }
    },
    async (input, init = {}) => {
      const url = new URL(String(input));
      calls.push(`${init.method || 'GET'} ${url.pathname}`);
      if (url.pathname.endsWith('/commands/claim')) {
        return jsonResponse(201, {
          command,
          claim_token: 'claim-token-retry-result'
        });
      }
      if (url.pathname.endsWith('/result')) {
        resultAttempts += 1;
        if (resultAttempts === 1) return jsonResponse(503, { error: 'temporary result outage' });
        return jsonResponse(201, { command: { ...command, status: 'succeeded' } });
      }
      return jsonResponse(500, { error: 'unexpected request' });
    }
  );

  assert.equal(await processor.pollOnce('rdesk_edge_retry'), 'result_pending');
  assert.equal(readFileSync(executionFile, 'utf8'), 'x');
  assert.equal(await processor.pollOnce('rdesk_edge_retry'), 'reported');
  assert.equal(readFileSync(executionFile, 'utf8'), 'x');
  assert.deepEqual(calls, [
    'POST /api/ivekit/rustdesk/devices/rdesk_edge_retry/commands/claim',
    `POST /api/ivekit/rustdesk/devices/rdesk_edge_retry/commands/${command.id}/result`,
    `POST /api/ivekit/rustdesk/devices/rdesk_edge_retry/commands/${command.id}/result`
  ]);
});

test('edge command processor recovers an executed spool and reports without re-executing', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'opc-rustdesk-edge-recovery-'));
  const spoolDir = join(dataDir, 'spool');
  const executionFile = join(dataDir, 'executions.txt');
  const calls: string[] = [];
  let resultAttempts = 0;
  const fetchImpl = async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = new URL(String(input));
    calls.push(`${init.method || 'GET'} ${url.pathname}`);
    if (url.pathname.endsWith('/commands/claim')) {
      return jsonResponse(201, { command, claim_token: 'initial-claim-token' });
    }
    if (url.pathname.endsWith('/recover')) {
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      assert.equal(body.state, 'executed');
      assert.equal(JSON.stringify(body).includes('claim_token'), false);
      return jsonResponse(201, {
        action: 'resume_report',
        command: { status: 'claimed', lease_expires_at: '2099-01-01T00:00:00.000Z' },
        claim_token: 'recovered-claim-token'
      });
    }
    if (url.pathname.endsWith('/result')) {
      resultAttempts += 1;
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      if (resultAttempts === 1) return jsonResponse(503, { error: 'response lost' });
      assert.equal(body.claim_token, 'recovered-claim-token');
      return jsonResponse(201, { command: { status: 'succeeded' } });
    }
    return jsonResponse(500, { error: 'unexpected request' });
  };
  const config = {
    baseUrl: 'https://opc.example.com',
    commandToken: 'edge-command-token-recovery',
    edgeInstanceId: 'edge-processor-recovery',
    commandLeaseMs: 30_000,
    spool: { directory: spoolDir },
    execution: {
      timeoutMs: 2_000,
      edgeInstanceId: 'edge-processor-recovery',
      edgeAgentVersion: '1.0.0',
      os: process.platform,
      disconnectAdapter: {
        executable: process.execPath,
        args: ['-e', `require('node:fs').appendFileSync(${JSON.stringify(executionFile)}, 'x')`]
      },
      restartAdapter: null
    }
  };

  const first = new RustDeskEdgeCommandProcessor(config, fetchImpl);
  assert.equal(await first.pollOnce(command.target_id), 'result_pending');
  await first.close();
  assert.equal(readFileSync(executionFile, 'utf8'), 'x');

  const restarted = new RustDeskEdgeCommandProcessor(config, fetchImpl);
  assert.equal(await restarted.pollOnce(command.target_id), 'reported');
  await restarted.close();
  assert.equal(readFileSync(executionFile, 'utf8'), 'x');
  assert.equal(readdirSync(spoolDir).includes('active.json'), false);
  assert.deepEqual(calls.map((item) => item.split('/').at(-1)), ['claim', 'result', 'recover', 'result']);
});

test('edge command processor quarantines uncertain executing state without running an adapter', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'opc-rustdesk-edge-uncertain-'));
  const spoolDir = join(dataDir, 'spool');
  const executionFile = join(dataDir, 'executions.txt');
  const { RustDeskEdgePendingFileStore } = await import('../scripts/rustdesk-edge-pending-store.js');
  const seed = await RustDeskEdgePendingFileStore.open({ directory: spoolDir });
  await seed.writeExecuting({
    edge_instance_id: 'edge-processor-uncertain',
    device_id: command.target_id,
    command,
    progress: []
  });
  await seed.close();

  const processor = new RustDeskEdgeCommandProcessor(
    {
      baseUrl: 'https://opc.example.com',
      commandToken: 'edge-command-token-uncertain',
      edgeInstanceId: 'edge-processor-uncertain',
      commandLeaseMs: 30_000,
      spool: { directory: spoolDir },
      execution: {
        timeoutMs: 2_000,
        edgeInstanceId: 'edge-processor-uncertain',
        edgeAgentVersion: '1.0.0',
        os: process.platform,
        disconnectAdapter: {
          executable: process.execPath,
          args: ['-e', `require('node:fs').appendFileSync(${JSON.stringify(executionFile)}, 'x')`]
        },
        restartAdapter: null
      }
    },
    async (input) => {
      const url = new URL(String(input));
      assert.equal(url.pathname.endsWith('/recover'), true);
      return jsonResponse(201, {
        action: 'quarantine',
        command: { status: 'failed' },
        reason: 'recovery_execution_state_uncertain'
      });
    }
  );

  assert.equal(await processor.pollOnce(command.target_id), 'quarantined');
  await processor.close();
  assert.throws(() => readFileSync(executionFile, 'utf8'), /ENOENT/);
  assert.equal(readdirSync(join(spoolDir, 'quarantine')).length, 1);
});

test('edge command processor reports fallback progress and completion', async () => {
  const bodies: Array<{ path: string; body: Record<string, unknown> }> = [];
  const processor = new RustDeskEdgeCommandProcessor(
    {
      baseUrl: 'https://opc.example.com',
      commandToken: 'edge-command-token-fallback',
      edgeInstanceId: 'edge-processor-fallback',
      commandLeaseMs: 30_000,
      execution: {
        timeoutMs: 2_000,
        edgeInstanceId: 'edge-processor-fallback',
        edgeAgentVersion: '1.0.0',
        os: process.platform,
        disconnectAdapter: {
          executable: process.execPath,
          args: ['-e', 'process.exit(2)']
        },
        restartAdapter: {
          executable: process.execPath,
          args: ['-e', 'process.exit(0)']
        }
      }
    },
    async (input, init = {}) => {
      const url = new URL(String(input));
      const body = init.body ? JSON.parse(String(init.body)) as Record<string, unknown> : {};
      bodies.push({ path: url.pathname, body });
      if (url.pathname.endsWith('/commands/claim')) {
        return jsonResponse(201, {
          command: {
            ...command,
            emergency_fallback_authorized: true,
            emergency_fallback_reason: 'approved emergency restart for processor test'
          },
          claim_token: 'claim-token-fallback'
        });
      }
      return jsonResponse(201, { command: { ...command, status: 'succeeded' } });
    }
  );

  assert.equal(await processor.pollOnce('rdesk_edge_fallback'), 'executed');
  assert.deepEqual(
    bodies.filter((item) => item.path.endsWith('/progress')).map((item) => item.body.progress),
    ['session_adapter_failed', 'fallback_started']
  );
  const resultBody = bodies.find((item) => item.path.endsWith('/result'))?.body;
  assert.equal(resultBody?.claim_token, 'claim-token-fallback');
  assert.equal(resultBody?.status, 'succeeded');
  assert.equal(resultBody?.execution_method, 'service_restart');
  assert.equal((resultBody?.metadata as Record<string, unknown>).collateral_sessions_may_disconnect, true);
});

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' }
  });
}
