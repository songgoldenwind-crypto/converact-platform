import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  MediaRejoinController,
  type MediaRejoinAttemptResult,
  type MediaRejoinScheduler
} from './media-rejoin-controller.js';

test('rejoin controller coalesces requests and uses bounded retry delays', async () => {
  const scheduler = new FakeScheduler();
  const outcomes: MediaRejoinAttemptResult[] = ['retry', 'succeeded'];
  let runs = 0;
  const controller = new MediaRejoinController({
    scheduler,
    delaysMs: [10, 20],
    run: async () => { runs += 1; return outcomes.shift()!; }
  });

  controller.request();
  controller.request();
  assert.deepEqual(scheduler.activeDelays(), [10]);
  await scheduler.runNext();
  assert.equal(runs, 1);
  assert.deepEqual(scheduler.activeDelays(), [20]);
  await scheduler.runNext();
  assert.equal(runs, 2);
  assert.deepEqual(scheduler.activeDelays(), []);

  controller.request();
  assert.deepEqual(scheduler.activeDelays(), [10]);
});

test('rejoin controller pauses while offline or hidden and resumes one attempt', async () => {
  const scheduler = new FakeScheduler();
  let runs = 0;
  const controller = new MediaRejoinController({
    scheduler,
    delaysMs: [10],
    run: async () => { runs += 1; return 'succeeded'; }
  });

  controller.request();
  controller.setOnline(false);
  assert.deepEqual(scheduler.activeDelays(), []);
  controller.setVisible(false);
  controller.setOnline(true);
  controller.request();
  assert.deepEqual(scheduler.activeDelays(), []);
  controller.setVisible(true);
  assert.deepEqual(scheduler.activeDelays(), [10]);
  await scheduler.runNext();
  assert.equal(runs, 1);
});

test('rejoin controller reports exhaustion once and dispose cancels pending work', async () => {
  const scheduler = new FakeScheduler();
  let exhausted = 0;
  const controller = new MediaRejoinController({
    scheduler,
    delaysMs: [1, 2],
    run: async () => 'retry',
    onExhausted: () => { exhausted += 1; }
  });

  controller.request();
  await scheduler.runNext();
  await scheduler.runNext();
  assert.equal(exhausted, 1);
  assert.deepEqual(scheduler.activeDelays(), []);

  controller.request();
  assert.deepEqual(scheduler.activeDelays(), [1]);
  controller.dispose();
  assert.deepEqual(scheduler.activeDelays(), []);
  await scheduler.runNext();
  assert.equal(exhausted, 1);
});

interface TimerItem {
  readonly id: number;
  readonly delay: number;
  readonly callback: () => void | Promise<void>;
  cancelled: boolean;
}

class FakeScheduler implements MediaRejoinScheduler {
  private sequence = 0;
  private readonly timers: TimerItem[] = [];

  setTimeout(callback: () => void | Promise<void>, delayMs: number): unknown {
    const timer: TimerItem = { id: ++this.sequence, delay: delayMs, callback, cancelled: false };
    this.timers.push(timer);
    return timer;
  }

  clearTimeout(handle: unknown): void {
    (handle as TimerItem).cancelled = true;
  }

  activeDelays(): number[] {
    return this.timers.filter((timer) => !timer.cancelled).map((timer) => timer.delay);
  }

  async runNext(): Promise<void> {
    const timer = this.timers.find((item) => !item.cancelled);
    if (!timer) return;
    timer.cancelled = true;
    await timer.callback();
  }
}
