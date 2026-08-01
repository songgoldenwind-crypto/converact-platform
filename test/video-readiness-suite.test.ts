import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  createVideoReadinessPersistedReport,
  createVideoReadinessSuiteConfigFromEnv,
  runVideoReadinessSuite,
  VideoReadinessSuiteError,
  writeVideoReadinessReport,
  type VideoReadinessCommandRunner
} from '../scripts/video-readiness-suite.js';

test('video readiness suite defaults to every production smoke target', () => {
  const config = createVideoReadinessSuiteConfigFromEnv({});

  assert.deepEqual(config.targets, [
    'media',
    'avatar',
    'ai-callback',
    'agent-browser',
    'customer-browser',
    'collaboration',
    'sip-volte'
  ]);
  assert.equal(config.continueOnFailure, false);
});

test('video readiness suite parses target aliases and continue mode', () => {
  const config = createVideoReadinessSuiteConfigFromEnv({
    CONVERACT_VIDEO_READINESS_TARGETS:
      'browser, customer, web-assist, web-assist-browser, remote-assist-browser, sip, avatar, ai-callback, collab, remote, remote-assistance, gateway, remote-gateway, meshcentral, guacamole, rustdesk',
    CONVERACT_VIDEO_READINESS_CONTINUE_ON_FAILURE: '1'
  });

  assert.deepEqual(config.targets, [
    'agent-browser',
    'customer-browser',
    'web-assist-browser',
    'sip-volte',
    'avatar',
    'ai-callback',
    'collaboration',
    'remote-gateway'
  ]);
  assert.equal(config.continueOnFailure, true);
});

test('video readiness suite rejects unknown targets', () => {
  assert.throws(
    () => createVideoReadinessSuiteConfigFromEnv({ CONVERACT_VIDEO_READINESS_TARGETS: 'media,unknown' }),
    /Unknown video readiness target: unknown/
  );
});

test('video readiness suite preflight reports missing env by target', async () => {
  await assert.rejects(
    () =>
      runVideoReadinessSuite(
        createVideoReadinessSuiteConfigFromEnv({
          CONVERACT_VIDEO_READINESS_TARGETS: 'media,customer-browser,collaboration'
        }),
        createCommandRunner()
      ),
    /media: CONVERACT_BASE_URL is required.*customer-browser: CONVERACT_FRONTEND_URL is required.*collaboration: CONVERACT_BASE_URL is required/s
  );
});

test('video readiness suite requires the SIP gateway switch to equal 1', async () => {
  const calls: string[] = [];

  await assert.rejects(
    () =>
      runVideoReadinessSuite(
        createVideoReadinessSuiteConfigFromEnv({
          CONVERACT_VIDEO_READINESS_TARGETS: 'sip-volte',
          CONVERACT_SIP_VOLTE_ENABLED: '0',
          LIVEKIT_URL: 'ws://livekit:7880',
          LIVEKIT_API_KEY: 'devkey',
          LIVEKIT_API_SECRET: 'secret',
          LIVEKIT_SIP_BRIDGE_TARGET: 'sip:livekit-bridge@livekit-sip:5061',
          RUSTPBX_LIVEKIT_TRUNK: 'livekit-bridge',
          RUSTPBX_RWI_URL: 'ws://rustpbx:8080/rwi/v1',
          RUSTPBX_RWI_TOKEN: 'rwi-token'
        }),
        createCommandRunner({ calls })
      ),
    /sip-volte: CONVERACT_SIP_VOLTE_ENABLED must equal 1/
  );

  assert.deepEqual(calls, []);
});

test('video readiness suite forces the SIP child check into active-gateway mode', async () => {
  const result = await runVideoReadinessSuite(
    createVideoReadinessSuiteConfigFromEnv({
      CONVERACT_VIDEO_READINESS_TARGETS: 'sip-volte',
      CONVERACT_SIP_VOLTE_ENABLED: '1',
      LIVEKIT_URL: 'ws://livekit:7880',
      LIVEKIT_API_KEY: 'devkey',
      LIVEKIT_API_SECRET: 'secret',
      LIVEKIT_SIP_BRIDGE_TARGET: 'sip:livekit-bridge@livekit-sip:5061',
      RUSTPBX_LIVEKIT_TRUNK: 'livekit-bridge',
      RUSTPBX_RWI_URL: 'ws://rustpbx:8080/rwi/v1',
      RUSTPBX_RWI_TOKEN: 'rwi-token'
    }),
    async (_command, _args, meta) => {
      assert.equal(meta.env.CONVERACT_SIP_VOLTE_REQUIRE_ACTIVE, '1');
      return { exitCode: 0, stdout: 'sip active', stderr: '' };
    }
  );

  assert.equal(result.ok, true);
});

test('video readiness suite preflight reports missing web assist browser env', async () => {
  await assert.rejects(
    () =>
      runVideoReadinessSuite(
        createVideoReadinessSuiteConfigFromEnv({
          CONVERACT_VIDEO_READINESS_TARGETS: 'web-assist-browser'
        }),
        createCommandRunner()
      ),
    /web-assist-browser: CONVERACT_FRONTEND_URL is required.*CONVERACT_WEB_ASSIST_CUSTOMER_URL or CONVERACT_REMOTE_ASSIST_CUSTOMER_URL is required.*CONVERACT_WEB_ASSIST_ENGINEER_TOKEN is required.*CONVERACT_WEB_ASSIST_ENGINEER_USER_ID is required.*CONVERACT_WEB_ASSIST_TENANT_ID or CONVERACT_TENANT_ID is required/s
  );
});

test('video readiness suite preflight requires customer invite signing for media target', async () => {
  await assert.rejects(
    () =>
      runVideoReadinessSuite(
        createVideoReadinessSuiteConfigFromEnv({
          CONVERACT_VIDEO_READINESS_TARGETS: 'media',
          CONVERACT_BASE_URL: 'http://localhost:3000',
          CONVERACT_MEDIA_API_TOKEN: 'media-token',
          CONVERACT_MEDIA_SMOKE_TENANT_ID: 'tenant-1'
        }),
        createCommandRunner()
      ),
    /media: CONVERACT_MEDIA_INVITE_SECRET or LIVEKIT_MEDIA_INVITE_SECRET is required/
  );
});

test('video readiness suite runs selected smoke commands in order', async () => {
  const calls: string[] = [];
  const result = await runVideoReadinessSuite(
    createVideoReadinessSuiteConfigFromEnv({
      CONVERACT_VIDEO_READINESS_TARGETS: 'media,avatar,ai-callback,web-assist-browser,collaboration,remote-gateway,sip-volte',
      CONVERACT_BASE_URL: 'http://localhost:3000',
      CONVERACT_FRONTEND_URL: 'http://localhost:5173',
      CONVERACT_MEDIA_API_TOKEN: 'media-token',
      CONVERACT_MEDIA_INVITE_SECRET: 'invite-secret',
      CONVERACT_MEDIA_SMOKE_TENANT_ID: 'tenant-1',
      CONVERACT_API_KEY: 'converact-key',
      CONVERACT_AI_CALLBACK_SMOKE_TENANT_ID: 'tenant-1',
      CONVERACT_WEB_ASSIST_CUSTOMER_URL:
        '/remote-assist/session?tenant_id=tenant-1&remote_session_id=remote-1&token=signed-customer',
      CONVERACT_WEB_ASSIST_ENGINEER_TOKEN: 'engineer-token',
      CONVERACT_WEB_ASSIST_ENGINEER_USER_ID: 'engineer-1',
      CONVERACT_TENANT_ID: 'tenant-1',
      CONVERACT_COLLAB_SMOKE_TENANT_ID: 'tenant-1',
      CONVERACT_REMOTE_GATEWAY_PROVIDER: 'meshcentral',
      CONVERACT_REMOTE_GATEWAY_BASE_URL: 'http://mesh.local',
      CONVERACT_REMOTE_GATEWAY_API_TOKEN: 'gateway-token',
      CONVERACT_REMOTE_GATEWAY_TARGET_ID: 'device-1',
      LIVEKIT_URL: 'ws://livekit:7880',
      LIVEKIT_API_KEY: 'devkey',
      LIVEKIT_API_SECRET: 'secret',
      CONVERACT_SIP_VOLTE_ENABLED: '1',
      LIVEKIT_SIP_BRIDGE_TARGET: 'sip:livekit-bridge@livekit-sip:5061',
      RUSTPBX_LIVEKIT_TRUNK: 'livekit-bridge',
      RUSTPBX_RWI_URL: 'ws://rustpbx:8080/rwi/v1',
      RUSTPBX_RWI_TOKEN: 'rwi-token'
    }),
    createCommandRunner({ calls })
  );

  assert.equal(result.ok, true);
  assert.deepEqual(result.steps.map((step) => step.target), [
    'media',
    'avatar',
    'ai-callback',
    'web-assist-browser',
    'collaboration',
    'remote-gateway',
    'sip-volte'
  ]);
  assert.deepEqual(calls, [
    'npm run smoke:media',
    'npm run smoke:media:avatar',
    'npm run smoke:media:ai-callback',
    'npm run smoke:media:web-assist-browser',
    'npm run smoke:collaboration',
    'npm run smoke:remote-gateway',
    'npm run smoke:media:sip-volte'
  ]);
});

test('video readiness suite accepts RustDesk-specific remote gateway env fallbacks', async () => {
  const calls: Array<{ command: string; env: NodeJS.ProcessEnv }> = [];
  const result = await runVideoReadinessSuite(
    createVideoReadinessSuiteConfigFromEnv({
      CONVERACT_VIDEO_READINESS_TARGETS: 'remote-gateway',
      CONVERACT_RUSTDESK_CONTROL_PLANE_BASE_URL: 'http://converact:3000',
      CONVERACT_RUSTDESK_API_TOKEN: 'rustdesk-token',
      CONVERACT_REMOTE_GATEWAY_TARGET_ID: 'rustdesk-device-1'
    }),
    async (command, args, meta) => {
      calls.push({ command: [command, ...args].join(' '), env: meta.env });
      return { exitCode: 0, stdout: 'remote gateway ok', stderr: '' };
    }
  );

  assert.equal(result.ok, true);
  assert.deepEqual(calls.map((call) => call.command), ['npm run smoke:remote-gateway']);
  assert.equal(calls[0]?.env.CONVERACT_RUSTDESK_CONTROL_PLANE_BASE_URL, 'http://converact:3000');
  assert.equal(calls[0]?.env.CONVERACT_RUSTDESK_API_TOKEN, 'rustdesk-token');
});

test('video readiness suite preflight requires RustDesk device-online auth inputs', async () => {
  await assert.rejects(
    () =>
      runVideoReadinessSuite(
        createVideoReadinessSuiteConfigFromEnv({
          CONVERACT_VIDEO_READINESS_TARGETS: 'remote-gateway',
          CONVERACT_RUSTDESK_CONTROL_PLANE_BASE_URL: 'http://converact:3000',
          CONVERACT_RUSTDESK_API_TOKEN: 'rustdesk-token',
          CONVERACT_REMOTE_GATEWAY_TARGET_ID: 'rustdesk-device-1',
          CONVERACT_RUSTDESK_CHECK_DEVICE_ONLINE: '1'
        }),
        createCommandRunner()
      ),
    /remote-gateway: CONVERACT_REMOTE_GATEWAY_TENANT_ID, CONVERACT_RUSTDESK_EDGE_TENANT_ID, or CONVERACT_TENANT_ID is required when CONVERACT_RUSTDESK_CHECK_DEVICE_ONLINE=1.*CONVERACT_API_KEY or CONVERACT_COLLABORATION_API_KEY is required when CONVERACT_RUSTDESK_CHECK_DEVICE_ONLINE=1/s
  );
});

test('video readiness suite accepts edge tenant fallback for RustDesk device-online preflight', async () => {
  const calls: string[] = [];
  const result = await runVideoReadinessSuite(
    createVideoReadinessSuiteConfigFromEnv({
      CONVERACT_VIDEO_READINESS_TARGETS: 'remote-gateway',
      CONVERACT_RUSTDESK_CONTROL_PLANE_BASE_URL: 'http://converact:3000',
      CONVERACT_RUSTDESK_API_TOKEN: 'rustdesk-token',
      CONVERACT_REMOTE_GATEWAY_TARGET_ID: 'rustdesk-device-1',
      CONVERACT_RUSTDESK_CHECK_DEVICE_ONLINE: '1',
      CONVERACT_RUSTDESK_EDGE_TENANT_ID: 'tenant_from_edge',
      CONVERACT_API_KEY: 'converact-key'
    }),
    async (command, args) => {
      calls.push([command, ...args].join(' '));
      return { exitCode: 0, stdout: 'remote gateway ok', stderr: '' };
    }
  );

  assert.equal(result.ok, true);
  assert.deepEqual(calls, ['npm run smoke:remote-gateway']);
});

test('video readiness suite passes media smoke customer join path to customer browser smoke', async () => {
  const calls: Array<{ target: string; command: string; env: NodeJS.ProcessEnv }> = [];
  const cleanupCalls: Array<{ method: string; path: string; query: URLSearchParams }> = [];
  const result = await runVideoReadinessSuite(
    createVideoReadinessSuiteConfigFromEnv({
      CONVERACT_VIDEO_READINESS_TARGETS: 'media,customer-browser',
      CONVERACT_BASE_URL: 'http://localhost:3000',
      CONVERACT_FRONTEND_URL: 'http://localhost:5173',
      CONVERACT_MEDIA_API_TOKEN: 'media-token',
      CONVERACT_MEDIA_INVITE_SECRET: 'invite-secret',
      CONVERACT_MEDIA_SMOKE_TENANT_ID: 'tenant-1'
    }),
    async (command, args, meta) => {
      calls.push({
        target: meta.target,
        command: [command, ...args].join(' '),
        env: meta.env
      });
      return {
        exitCode: 0,
        stdout:
          meta.target === 'media'
            ? JSON.stringify({
                roomName: 'smoke-room',
                customerJoinPath: '/video?room=smoke-room&tenant_id=tenant-1'
              })
            : '',
        stderr: ''
      };
    },
    async (input, init = {}) => {
      const url = new URL(String(input));
      cleanupCalls.push({
        method: init.method || 'GET',
        path: url.pathname,
        query: url.searchParams
      });
      return jsonResponse({ room_name: 'smoke-room', status: 'closed' });
    }
  );

  assert.equal(result.ok, true);
  assert.deepEqual(calls.map((call) => call.command), [
    'npm run smoke:media',
    'npm run smoke:media:customer-browser'
  ]);
  assert.equal(calls.find((call) => call.target === 'media')?.env.CONVERACT_MEDIA_SMOKE_KEEP_ROOM_OPEN, '1');
  assert.equal(
    calls.find((call) => call.target === 'customer-browser')?.env.CONVERACT_CUSTOMER_VIDEO_URL,
    '/video?room=smoke-room&tenant_id=tenant-1'
  );
  assert.equal(calls.find((call) => call.target === 'media')?.env.CONVERACT_MEDIA_SMOKE_REQUIRE_CONFIGURED_LIVEKIT, '1');
  assert.deepEqual(cleanupCalls.map((call) => `${call.method} ${call.path}`), [
    'POST /api/media/livekit/rooms/smoke-room/close'
  ]);
  assert.equal(cleanupCalls[0]?.query.get('tenant_id'), 'tenant-1');
});

test('video readiness suite cleans retained media room when a later target fails before customer browser', async () => {
  const cleanupCalls: Array<{ method: string; path: string; query: URLSearchParams }> = [];
  await assert.rejects(
    () =>
      runVideoReadinessSuite(
        createVideoReadinessSuiteConfigFromEnv({
          CONVERACT_VIDEO_READINESS_TARGETS: 'media,avatar,customer-browser',
          CONVERACT_BASE_URL: 'http://localhost:3000',
          CONVERACT_FRONTEND_URL: 'http://localhost:5173',
          CONVERACT_MEDIA_API_TOKEN: 'media-token',
          CONVERACT_MEDIA_INVITE_SECRET: 'invite-secret',
          CONVERACT_MEDIA_SMOKE_TENANT_ID: 'tenant-1',
          LIVEKIT_URL: 'ws://livekit:7880',
          LIVEKIT_API_KEY: 'devkey',
          LIVEKIT_API_SECRET: 'secret'
        }),
        async (_command, _args, meta) => {
          if (meta.target === 'media') {
            return {
              exitCode: 0,
              stdout: JSON.stringify({
                roomName: 'smoke-room',
                customerJoinPath: '/video?room=smoke-room&tenant_id=tenant-1'
              }),
              stderr: ''
            };
          }
          return { exitCode: 1, stdout: '', stderr: `${meta.target} failed` };
        },
        async (input, init = {}) => {
          const url = new URL(String(input));
          cleanupCalls.push({
            method: init.method || 'GET',
            path: url.pathname,
            query: url.searchParams
          });
          return jsonResponse({ room_name: 'smoke-room', status: 'closed' });
        }
      ),
    /video readiness target avatar failed with exit code 1/
  );

  assert.deepEqual(cleanupCalls.map((call) => `${call.method} ${call.path}`), [
    'POST /api/media/livekit/rooms/smoke-room/close'
  ]);
  assert.equal(cleanupCalls[0]?.query.get('tenant_id'), 'tenant-1');
});

test('video readiness suite fails fast when media smoke does not return a customer join path', async () => {
  const calls: string[] = [];
  const cleanupCalls: Array<{ method: string; path: string; query: URLSearchParams }> = [];
  await assert.rejects(
    () =>
      runVideoReadinessSuite(
        createVideoReadinessSuiteConfigFromEnv({
          CONVERACT_VIDEO_READINESS_TARGETS: 'media,customer-browser',
          CONVERACT_BASE_URL: 'http://localhost:3000',
          CONVERACT_FRONTEND_URL: 'http://localhost:5173',
          CONVERACT_MEDIA_API_TOKEN: 'media-token',
          CONVERACT_MEDIA_INVITE_SECRET: 'invite-secret',
          CONVERACT_MEDIA_SMOKE_TENANT_ID: 'tenant-1'
        }),
        async (command, args, meta) => {
          calls.push([command, ...args].join(' '));
          return {
            exitCode: 0,
            stdout:
              meta.target === 'media'
                ? JSON.stringify({ roomName: 'smoke-room' })
                : 'customer should not run',
            stderr: ''
          };
        },
        async (input, init = {}) => {
          const url = new URL(String(input));
          cleanupCalls.push({
            method: init.method || 'GET',
            path: url.pathname,
            query: url.searchParams
          });
          return jsonResponse({ room_name: 'smoke-room', status: 'closed' });
        }
      ),
    /media smoke did not return customerJoinPath/
  );

  assert.deepEqual(calls, ['npm run smoke:media']);
  assert.deepEqual(cleanupCalls.map((call) => `${call.method} ${call.path}`), [
    'POST /api/media/livekit/rooms/smoke-room/close'
  ]);
  assert.equal(cleanupCalls[0]?.query.get('tenant_id'), 'tenant-1');
});

test('video readiness suite skips dependent customer browser when media join path is missing in continue mode', async () => {
  const calls: string[] = [];
  const result = await runVideoReadinessSuite(
    createVideoReadinessSuiteConfigFromEnv({
      CONVERACT_VIDEO_READINESS_TARGETS: 'media,customer-browser,avatar',
      CONVERACT_VIDEO_READINESS_CONTINUE_ON_FAILURE: '1',
      CONVERACT_BASE_URL: 'http://localhost:3000',
      CONVERACT_FRONTEND_URL: 'http://localhost:5173',
      CONVERACT_MEDIA_API_TOKEN: 'media-token',
      CONVERACT_MEDIA_INVITE_SECRET: 'invite-secret',
      CONVERACT_MEDIA_SMOKE_TENANT_ID: 'tenant-1',
      LIVEKIT_URL: 'ws://livekit:7880',
      LIVEKIT_API_KEY: 'devkey',
      LIVEKIT_API_SECRET: 'secret'
    }),
    async (command, args, meta) => {
      calls.push([command, ...args].join(' '));
      return {
        exitCode: 0,
        stdout:
          meta.target === 'media'
            ? JSON.stringify({ roomName: 'smoke-room' })
            : `${meta.target} ok`,
        stderr: ''
      };
    },
    async () => jsonResponse({ room_name: 'smoke-room', status: 'closed' })
  );

  assert.equal(result.ok, false);
  assert.deepEqual(calls, ['npm run smoke:media', 'npm run smoke:media:avatar']);
  assert.deepEqual(result.steps.map((step) => [step.target, step.ok]), [
    ['media', true],
    ['customer-browser', false],
    ['media-cleanup', true],
    ['avatar', true]
  ]);
});

test('video readiness suite failure exposes a structured partial report', async () => {
  let captured: VideoReadinessSuiteError | null = null;
  try {
    await runVideoReadinessSuite(
      createVideoReadinessSuiteConfigFromEnv({
        CONVERACT_VIDEO_READINESS_TARGETS: 'media,avatar,customer-browser',
        CONVERACT_BASE_URL: 'http://localhost:3000',
        CONVERACT_FRONTEND_URL: 'http://localhost:5173',
        CONVERACT_MEDIA_API_TOKEN: 'media-token',
        CONVERACT_MEDIA_INVITE_SECRET: 'invite-secret',
        CONVERACT_MEDIA_SMOKE_TENANT_ID: 'tenant-1',
        LIVEKIT_URL: 'ws://livekit:7880',
        LIVEKIT_API_KEY: 'devkey',
        LIVEKIT_API_SECRET: 'secret'
      }),
      async (_command, _args, meta) => {
        if (meta.target === 'media') {
          return {
            exitCode: 0,
            stdout: JSON.stringify({
              roomName: 'smoke-room',
              customerJoinPath: '/video?room=smoke-room&tenant_id=tenant-1'
            }),
            stderr: ''
          };
        }
        return {
          exitCode: 1,
          stdout: 'avatar stdout details',
          stderr: 'avatar failed details'
        };
      },
      async () => jsonResponse({ room_name: 'smoke-room', status: 'closed' })
    );
  } catch (error) {
    if (error instanceof VideoReadinessSuiteError) captured = error;
    else throw error;
  }

  assert.ok(captured);
  assert.equal(captured.result.ok, false);
  assert.deepEqual(captured.result.steps.map((step) => [step.target, step.ok]), [
    ['media', true],
    ['avatar', false],
    ['media-cleanup', true]
  ]);
  assert.match(captured.result.steps[0].stdout, /customerJoinPath/);
  assert.match(captured.result.steps[1].stdout, /avatar stdout details/);
  assert.match(captured.result.steps[1].stderr, /avatar failed details/);
  assert.equal(captured.result.steps[2].command, 'POST /api/media/livekit/rooms/smoke-room/close');
});

test('video readiness suite turns runner errors into structured failures and cleans retained rooms', async () => {
  let captured: VideoReadinessSuiteError | null = null;
  try {
    await runVideoReadinessSuite(
      createVideoReadinessSuiteConfigFromEnv({
        CONVERACT_VIDEO_READINESS_TARGETS: 'media,avatar,customer-browser',
        CONVERACT_BASE_URL: 'http://localhost:3000',
        CONVERACT_FRONTEND_URL: 'http://localhost:5173',
        CONVERACT_MEDIA_API_TOKEN: 'media-token',
        CONVERACT_MEDIA_INVITE_SECRET: 'invite-secret',
        CONVERACT_MEDIA_SMOKE_TENANT_ID: 'tenant-1',
        LIVEKIT_URL: 'ws://livekit:7880',
        LIVEKIT_API_KEY: 'devkey',
        LIVEKIT_API_SECRET: 'secret'
      }),
      async (_command, _args, meta) => {
        if (meta.target === 'media') {
          return {
            exitCode: 0,
            stdout: JSON.stringify({
              roomName: 'smoke-room',
              customerJoinPath: '/video?room=smoke-room&tenant_id=tenant-1'
            }),
            stderr: ''
          };
        }
        throw new Error('spawn failed');
      },
      async () => jsonResponse({ room_name: 'smoke-room', status: 'closed' })
    );
  } catch (error) {
    if (error instanceof VideoReadinessSuiteError) captured = error;
    else throw error;
  }

  assert.ok(captured);
  assert.equal(captured.result.ok, false);
  assert.deepEqual(captured.result.steps.map((step) => [step.target, step.ok]), [
    ['media', true],
    ['avatar', false],
    ['media-cleanup', true]
  ]);
  assert.match(captured.result.steps[1].stderr, /spawn failed/);
});

test('video readiness suite cleanup failure also exposes a structured report', async () => {
  let captured: VideoReadinessSuiteError | null = null;
  try {
    await runVideoReadinessSuite(
      createVideoReadinessSuiteConfigFromEnv({
        CONVERACT_VIDEO_READINESS_TARGETS: 'media,customer-browser',
        CONVERACT_BASE_URL: 'http://localhost:3000',
        CONVERACT_FRONTEND_URL: 'http://localhost:5173',
        CONVERACT_MEDIA_API_TOKEN: 'media-token',
        CONVERACT_MEDIA_INVITE_SECRET: 'invite-secret',
        CONVERACT_MEDIA_SMOKE_TENANT_ID: 'tenant-1'
      }),
      async (_command, _args, meta) => ({
        exitCode: 0,
        stdout:
          meta.target === 'media'
            ? JSON.stringify({
                roomName: 'smoke-room',
                customerJoinPath: '/video?room=smoke-room&tenant_id=tenant-1'
              })
            : 'customer browser ok',
        stderr: ''
      }),
      async () => jsonResponse({ error: 'cleanup denied' }, 503)
    );
  } catch (error) {
    if (error instanceof VideoReadinessSuiteError) captured = error;
  }

  assert.ok(captured);
  assert.match(captured.message, /video readiness media cleanup failed with status 503/);
  assert.equal(captured.result.ok, false);
  assert.deepEqual(captured.result.steps.map((step) => [step.target, step.ok]), [
    ['media', true],
    ['customer-browser', true],
    ['media-cleanup', false]
  ]);
  assert.match(captured.result.steps[2].stdout, /cleanup denied/);
  assert.match(captured.result.steps[2].stderr, /cleanup denied/);
});

test('video readiness suite stops on first command failure by default', async () => {
  const calls: string[] = [];

  await assert.rejects(
    () =>
      runVideoReadinessSuite(
        createVideoReadinessSuiteConfigFromEnv({
        CONVERACT_VIDEO_READINESS_TARGETS: 'media,avatar',
        CONVERACT_BASE_URL: 'http://localhost:3000',
        CONVERACT_MEDIA_API_TOKEN: 'media-token',
        CONVERACT_MEDIA_INVITE_SECRET: 'invite-secret',
        CONVERACT_MEDIA_SMOKE_TENANT_ID: 'tenant-1',
        LIVEKIT_URL: 'ws://livekit:7880',
        LIVEKIT_API_KEY: 'devkey',
          LIVEKIT_API_SECRET: 'secret'
        }),
        createCommandRunner({ calls, failures: new Set(['media']) })
      ),
    /video readiness target media failed with exit code 1/
  );

  assert.deepEqual(calls, ['npm run smoke:media']);
});

test('video readiness suite can continue after failures and return a failed report', async () => {
  const calls: string[] = [];
  const result = await runVideoReadinessSuite(
    createVideoReadinessSuiteConfigFromEnv({
      CONVERACT_VIDEO_READINESS_TARGETS: 'media,avatar',
      CONVERACT_VIDEO_READINESS_CONTINUE_ON_FAILURE: '1',
      CONVERACT_BASE_URL: 'http://localhost:3000',
      CONVERACT_MEDIA_API_TOKEN: 'media-token',
      CONVERACT_MEDIA_INVITE_SECRET: 'invite-secret',
      CONVERACT_MEDIA_SMOKE_TENANT_ID: 'tenant-1',
      LIVEKIT_URL: 'ws://livekit:7880',
      LIVEKIT_API_KEY: 'devkey',
      LIVEKIT_API_SECRET: 'secret'
    }),
    createCommandRunner({ calls, failures: new Set(['media']) })
  );

  assert.equal(result.ok, false);
  assert.deepEqual(result.steps.map((step) => [step.target, step.ok]), [
    ['media', false],
    ['avatar', true]
  ]);
  assert.deepEqual(calls, ['npm run smoke:media', 'npm run smoke:media:avatar']);
});

test('video readiness persisted report hashes output without storing tokens or signed invites', () => {
  const result = {
    ok: false,
    steps: [{
      target: 'media' as const,
      command: 'npm run smoke:media',
      ok: false,
      exitCode: 1,
      durationMs: 25,
      stdout: JSON.stringify({
        token: 'livekit-secret-token',
        customerJoinPath: '/video?invite=signed-customer-invite&expires_at=9999999999'
      }),
      stderr: 'Bearer private-media-token failed'
    }]
  };

  const persisted = createVideoReadinessPersistedReport(result, '2026-07-11T00:00:00.000Z');
  const serialized = JSON.stringify(persisted);

  assert.equal(persisted.schema_version, 1);
  assert.equal(persisted.ok, false);
  assert.equal(persisted.steps[0]?.stdout_present, true);
  assert.equal(persisted.steps[0]?.stderr_present, true);
  assert.equal(persisted.steps[0]?.error_summary, 'media failed with exit code 1');
  assert.match(persisted.steps[0]?.stdout_sha256 || '', /^[a-f0-9]{64}$/);
  assert.match(persisted.steps[0]?.stderr_sha256 || '', /^[a-f0-9]{64}$/);
  assert.equal(serialized.includes('livekit-secret-token'), false);
  assert.equal(serialized.includes('signed-customer-invite'), false);
  assert.equal(serialized.includes('private-media-token'), false);
});

test('video readiness CLI writes a failed artifact when preflight stops before the first step', () => {
  const dir = mkdtempSync(join(tmpdir(), 'converact-video-readiness-preflight-report-'));
  const outputFile = join(dir, 'readiness.json');
  try {
    const result = spawnSync(
      process.execPath,
      ['--import', 'tsx', 'scripts/video-readiness-suite.ts'],
      {
        cwd: new URL('..', import.meta.url),
        encoding: 'utf8',
        env: {
          ...process.env,
          CONVERACT_VIDEO_READINESS_TARGETS: 'media',
          CONVERACT_VIDEO_READINESS_REPORT_FILE: outputFile,
          CONVERACT_BASE_URL: '',
          CONVERACT_MEDIA_API_TOKEN: '',
          CONVERACT_MEDIA_INVITE_SECRET: '',
          CONVERACT_MEDIA_SMOKE_TENANT_ID: ''
        }
      }
    );
    const report = JSON.parse(readFileSync(outputFile, 'utf8')) as {
      ok: boolean;
      steps: unknown[];
    };

    assert.notEqual(result.status, 0);
    assert.equal(report.ok, false);
    assert.deepEqual(report.steps, []);
    assert.equal(readFileSync(outputFile, 'utf8').includes('media-token'), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('video readiness report writer creates a secret-safe JSON artifact', () => {
  const dir = mkdtempSync(join(tmpdir(), 'converact-video-readiness-report-'));
  const outputFile = join(dir, 'nested', 'readiness.json');
  try {
    const write = writeVideoReadinessReport(outputFile, {
      ok: true,
      steps: [{
        target: 'agent-browser',
        command: 'npm run smoke:media:browser',
        ok: true,
        exitCode: 0,
        durationMs: 100,
        stdout: 'browser output with token=do-not-persist',
        stderr: ''
      }]
    }, '2026-07-11T00:00:00.000Z');
    const stored = JSON.parse(readFileSync(outputFile, 'utf8')) as Record<string, unknown>;

    assert.equal(write.outputFile, outputFile);
    assert.equal(write.ok, true);
    assert.equal(write.steps, 1);
    assert.equal(JSON.stringify(stored).includes('do-not-persist'), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

function createCommandRunner(options?: {
  calls?: string[];
  failures?: Set<string>;
}): VideoReadinessCommandRunner {
  return async (command, args, meta) => {
    options?.calls?.push([command, ...args].join(' '));
    const failed = options?.failures?.has(meta.target) || false;
    return {
      exitCode: failed ? 1 : 0,
      stdout: failed ? '' : `${meta.target} ok`,
      stderr: failed ? `${meta.target} failed` : ''
    };
  };
}

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' }
  });
}
