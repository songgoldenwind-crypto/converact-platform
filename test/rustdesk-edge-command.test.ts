import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import {
  executeRustDeskDisconnectCommand,
  RustDeskEdgeCommandProcessor,
  type RustDeskEdgeClaimCommand,
  type RustDeskEdgeCommandProgressReport
} from '../scripts/rustdesk-edge-command.js';

const command: RustDeskEdgeClaimCommand = {
  id: 'rdcmd_edge_execution_1',
  command_type: 'disconnect_session',
  external_id: 'rdgw_edge_execution_1',
  target_id: 'rdesk_edge_execution_1',
  rustdesk_id: '123456789',
  requested_reason: 'consent_revoked',
  attempt: 1,
  lease_expires_at: '2099-01-01T00:00:00.000Z'
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
        `const expected = ['--external-id','rdgw_edge_execution_1','--target-id','rdesk_edge_execution_1','--rustdesk-id','123456789','--reason','consent_revoked'];
         process.exit(JSON.stringify(process.argv.slice(1)) === JSON.stringify(expected) ? 0 : 8);`,
        '--',
        '--external-id', '{external_id}',
        '--target-id', '{target_id}',
        '--rustdesk-id', '{rustdesk_id}',
        '--reason', '{requested_reason}'
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

test('edge command falls back to service restart after primary failure', async () => {
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

  assert.equal(result.status, 'succeeded');
  assert.equal(result.execution_method, 'service_restart');
  assert.equal(result.exit_code, 0);
  assert.equal(result.metadata.collateral_sessions_may_disconnect, true);
  assert.equal(result.metadata.fallback_reason, 'adapter_exit_nonzero');
  assert.deepEqual(progress.map((item) => item.progress), [
    'session_adapter_failed',
    'fallback_started'
  ]);
  assert.equal(progress[0]?.exit_code, 2);
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
  assert.equal(result.execution_method, 'service_restart');
  assert.equal(result.metadata.fallback_reason, 'targeted_disconnect_unavailable');
  assert.equal(result.metadata.fallback_result_reason, 'service_unavailable');
});

test('edge command times out the primary adapter before running fallback', async () => {
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

  assert.equal(result.status, 'succeeded');
  assert.equal(result.execution_method, 'service_restart');
  assert.equal(progress[0]?.metadata.timed_out, true);
  assert.equal(result.metadata.fallback_reason, 'adapter_timeout');
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

  assert.equal(result.status, 'succeeded');
  assert.equal(result.metadata.fallback_reason, 'adapter_timeout');
  assert.ok(Date.now() - startedAt < 1_000);
});

test('edge command reports failed when the service restart fallback fails', async () => {
  const progress: RustDeskEdgeCommandProgressReport[] = [];
  const result = await executeRustDeskDisconnectCommand(
    command,
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
        return jsonResponse(201, { command, claim_token: 'claim-token-fallback' });
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
