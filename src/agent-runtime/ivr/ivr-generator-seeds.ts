/** Few-shot examples for IVR LLM generation — full graphs per nl-generate plan Task 3. */

import type { IvrFlowGraph } from './ivr-types.js';

export const M1_SEED_GRAPH: IvrFlowGraph = {
  version: 1,
  entryNodeId: 'start',
  variables: [],
  nodes: [
    { id: 'start', type: 'start', name: '开始', position: { x: 0, y: 0 }, data: { pushParams: [] } },
    {
      id: 'play1',
      type: 'play',
      name: '欢迎',
      position: { x: 200, y: 0 },
      data: {
        contents: [
          { playType: 'tts', ttsEngine: 'ali', text: 'welcome-one' },
          { playType: 'tts', ttsEngine: 'ali', text: 'welcome-two' },
        ],
      },
    },
    {
      id: 'menu1',
      type: 'menu',
      name: '主菜单',
      position: { x: 400, y: 0 },
      data: {
        prompt: [{ playType: 'tts', ttsEngine: 'ali', text: 'press 1 for sales' }],
        options: [{ digit: '1', label: '销售', routeType: 'node', routeTarget: 't1' }],
        timeoutSec: 10,
        maxRetries: 1,
      },
    },
    {
      id: 't1',
      type: 'transfer',
      name: '销售队列',
      position: { x: 600, y: 0 },
      data: { targetType: 'queue', targetValue: 'sales' },
    },
  ],
  edges: [
    { id: 'e0', source: 'start', target: 'play1', sourceHandle: 'out' },
    { id: 'e1', source: 'play1', target: 'menu1', sourceHandle: 'out' },
    { id: 'e2', source: 'menu1', target: 't1', sourceHandle: 'digit_1' },
  ],
};

export const FEW_SHOT_M1 = JSON.stringify(M1_SEED_GRAPH);

export const FEW_SHOT_TIME_CONDITION = JSON.stringify({
  version: 1,
  entryNodeId: 'start',
  variables: [],
  nodes: [
    { id: 'start', type: 'start', name: '开始', position: { x: 0, y: 0 }, data: {} },
    {
      id: 'play1',
      type: 'play',
      name: '欢迎',
      position: { x: 200, y: 0 },
      data: { contents: [{ playType: 'tts', text: '欢迎致电' }] },
    },
    {
      id: 'tc1',
      type: 'time_condition',
      name: '工作时间',
      position: { x: 400, y: 0 },
      data: { scheduleId: 'business_hours' },
    },
    {
      id: 'menu1',
      type: 'menu',
      name: '人工菜单',
      position: { x: 600, y: -50 },
      data: {
        prompt: [{ playType: 'tts', text: '按1转人工' }],
        options: [{ digit: '1', label: '人工', routeType: 'node', routeTarget: 't1' }],
        timeoutSec: 10,
        maxRetries: 1,
      },
    },
    {
      id: 'vm1',
      type: 'voicemail',
      name: '非工作时间留言',
      position: { x: 600, y: 80 },
      data: { maxDurationSec: 60 },
    },
    {
      id: 't1',
      type: 'transfer',
      name: '转人工',
      position: { x: 800, y: -50 },
      data: { targetType: 'queue', targetValue: 'support' },
    },
  ],
  edges: [
    { id: 'e0', source: 'start', target: 'play1', sourceHandle: 'out' },
    { id: 'e1', source: 'play1', target: 'tc1', sourceHandle: 'out' },
    { id: 'e2', source: 'tc1', target: 'menu1', sourceHandle: 'true' },
    { id: 'e3', source: 'tc1', target: 'vm1', sourceHandle: 'false' },
    { id: 'e4', source: 'menu1', target: 't1', sourceHandle: 'digit_1' },
  ],
});
