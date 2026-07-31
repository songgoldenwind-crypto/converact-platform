/**
 * P1 — HTTP / webhook 三分支路由单测 + timeout fallback。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { routeHttpBranch, routeWebhookBranch } from '../src/agent-runtime/ivr/ivr-io-branch-handler.js';
import type { IvrFlowGraph } from '../src/agent-runtime/ivr/ivr-types.js';
import { IVR_BRANCH } from '../src/agent-runtime/ivr/ivr-branch-handles.js';

function ioGraph(handles: string[]): IvrFlowGraph {
  const nodes = [
    { id: 'n1', type: 'http' as const, name: 'H', position: { x: 0, y: 0 }, data: {} },
    ...handles.map((h, i) => ({
      id: `t_${h}`,
      type: 'play' as const,
      name: h,
      position: { x: 200, y: i * 50 },
      data: { contents: [{ playType: 'tts', text: h }] },
    })),
  ];
  const edges = handles.map((h) => ({
    id: `e_${h}`,
    source: 'n1',
    target: `t_${h}`,
    sourceHandle: h,
  }));
  return { version: 1, entryNodeId: 'n1', variables: [], nodes, edges };
}

test('routeHttpBranch: timeout → timeout edge when present', () => {
  const vars: Record<string, string> = {};
  const route = routeHttpBranch(ioGraph(['success', 'fail', 'timeout']), 'n1', {
    success: false,
    statusCode: 0,
    error: 'timeout',
  }, vars);
  assert.equal(route.branch, IVR_BRANCH.TIMEOUT);
  assert.equal(route.target, 't_timeout');
  assert.equal(vars.http_status, '0');
});

test('routeHttpBranch: timeout without timeout edge falls back to fail', () => {
  const vars: Record<string, string> = {};
  const route = routeHttpBranch(ioGraph(['success', 'fail']), 'n1', {
    success: false,
    statusCode: 0,
    error: 'timeout',
  }, vars);
  assert.equal(route.branch, IVR_BRANCH.FAIL);
  assert.equal(route.target, 't_fail');
});

test('routeHttpBranch: timeout fallback when fail edge also missing → null target', () => {
  const vars: Record<string, string> = {};
  const route = routeHttpBranch(ioGraph(['success']), 'n1', {
    success: false,
    statusCode: 0,
    error: 'timeout',
  }, vars);
  assert.equal(route.branch, IVR_BRANCH.FAIL);
  assert.equal(route.target, null);
});

test('routeHttpBranch: fail without error message uses http_failed', () => {
  const vars: Record<string, string> = {};
  routeHttpBranch(ioGraph(['success', 'fail']), 'n1', { success: false, statusCode: 503 }, vars);
  assert.equal(vars.last_error, 'http_failed');
  assert.equal(vars.http_status, '503');
});

test('routeWebhookBranch: timeout fallback mirrors http', () => {
  const vars: Record<string, string> = {};
  const route = routeWebhookBranch(ioGraph(['success', 'fail']), 'n1', {
    success: false,
    statusCode: 0,
    error: 'timeout',
  }, vars);
  assert.equal(route.branch, IVR_BRANCH.FAIL);
  assert.equal(route.target, 't_fail');
  assert.equal(vars.webhook_status, '0');
});
