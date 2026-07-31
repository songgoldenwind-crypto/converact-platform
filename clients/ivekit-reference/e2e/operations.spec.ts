import { mkdirSync } from 'node:fs';

import { expect, test, type Browser, type BrowserContext, type Page, type TestInfo } from '@playwright/test';

test('desktop Queue Monitor renders live operations and refreshes in place', async ({ browser }, testInfo) => {
  const monitor = await openMonitor(browser, { width: 1440, height: 900 });
  try {
    await expect(monitor.page.getByLabel('Queue status table').getByText('LED Support', { exact: true })).toBeVisible();
    await expect(monitor.page.getByText('No agent capacity')).toBeVisible();
    await expect(monitor.page.getByTestId('metric-waiting')).toHaveText('9');

    await monitor.page.getByTitle('Refresh queue monitor').click();
    await expect(monitor.page.getByTestId('metric-waiting')).toHaveText('8');

    const layout = await monitor.page.evaluate(() => {
      const rect = (selector: string) => {
        const value = document.querySelector(selector)?.getBoundingClientRect();
        return value ? {
          left: value.left, right: value.right, top: value.top, bottom: value.bottom,
          width: value.width, height: value.height
        } : null;
      };
      return {
        width: innerWidth,
        height: innerHeight,
        scrollWidth: document.documentElement.scrollWidth,
        topbar: rect('.topbar'),
        header: rect('.queue-monitor-header'),
        metrics: rect('.queue-metrics'),
        body: rect('.queue-monitor-body'),
        alerts: rect('.queue-alert-panel'),
        table: rect('.queue-table-panel')
      };
    });
    expect(layout.scrollWidth).toBe(layout.width);
    expect(layout.topbar?.bottom).toBeLessThanOrEqual(layout.header?.top || 0);
    expect(layout.header?.bottom).toBeLessThanOrEqual(layout.metrics?.top || 0);
    expect(layout.metrics?.bottom).toBeLessThanOrEqual(layout.body?.top || 0);
    expect(layout.alerts?.right).toBeLessThanOrEqual(layout.table?.left || 0);
    expect(layout.body?.bottom).toBeLessThanOrEqual(layout.height);
    await capture(monitor.page, testInfo, 'ivekit-queue-monitor-desktop.png');
  } finally {
    await monitor.context.close();
  }
});

test('mobile Queue Monitor contains page overflow and keeps table scrolling local', async ({ browser }, testInfo) => {
  const monitor = await openMonitor(browser, { width: 390, height: 844 });
  try {
    await expect(monitor.page.getByLabel('Queue status table').getByText('LED Support', { exact: true })).toBeVisible();
    const layout = await monitor.page.evaluate(() => {
      const monitor = document.querySelector('.queue-monitor')?.getBoundingClientRect();
      const controls = document.querySelector('.queue-table-controls')?.getBoundingClientRect();
      const scroller = document.querySelector('.queue-table-scroll') as HTMLElement | null;
      const refresh = document.querySelector('button[title="Refresh queue monitor"]')?.getBoundingClientRect();
      return {
        width: innerWidth,
        height: innerHeight,
        scrollWidth: document.documentElement.scrollWidth,
        monitor: monitor ? { left: monitor.left, right: monitor.right, bottom: monitor.bottom } : null,
        controls: controls ? { left: controls.left, right: controls.right, height: controls.height } : null,
        refresh: refresh ? { left: refresh.left, right: refresh.right, bottom: refresh.bottom } : null,
        tableClientWidth: scroller?.clientWidth || 0,
        tableScrollWidth: scroller?.scrollWidth || 0
      };
    });
    expect(layout.scrollWidth).toBe(layout.width);
    expect(layout.monitor?.left).toBeGreaterThanOrEqual(0);
    expect(layout.monitor?.right).toBeLessThanOrEqual(layout.width);
    expect(layout.monitor?.bottom).toBeLessThanOrEqual(layout.height);
    expect(layout.controls?.right).toBeLessThanOrEqual(layout.width);
    expect(layout.refresh?.right).toBeLessThanOrEqual(layout.width);
    expect(layout.tableScrollWidth).toBeGreaterThan(layout.tableClientWidth);
    await capture(monitor.page, testInfo, 'ivekit-queue-monitor-mobile.png');
  } finally {
    await monitor.context.close();
  }
});

async function openMonitor(
  browser: Browser,
  viewport: { width: number; height: number }
): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext({ viewport });
  await context.addInitScript(() => {
    window.__IVEKIT_DEV_ACCESS_TOKEN__ = 'operations-token';
    window.__IVEKIT_DEV_IDENTITY__ = 'operations-viewer';
  });
  const page = await context.newPage();
  let monitorRequests = 0;
  await page.route('**/ivekit-config.json', (route) => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify({ baseUrl: 'http://127.0.0.1:4179', tenantId: 'tenant-e2e' })
  }));
  await page.route('**/api/ivekit/events*', (route) => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify({
      items: [], next_cursor: 'event-head', has_more: false, snapshot_required: false
    })
  }));
  await page.route('**/api/ivekit/contact-center/monitor', (route) => {
    monitorRequests += 1;
    return route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify(snapshot(monitorRequests === 1 ? 7 : 6))
    });
  });
  await page.goto('/?workspace=operations');
  await expect(page.getByRole('region', { name: 'Contact Center queue monitor' })).toBeVisible();
  return { context, page };
}

function snapshot(waiting: number) {
  return {
    generated_at: '2026-07-13T09:30:00.000Z',
    agents: {
      configured: 12, active: 10, offline: 2, available: 3, busy: 5,
      after_call: 1, away: 1, active_voice_count: 7, voice_capacity: 12
    },
    calls: { active_inbound: 6, active_outbound: 2 },
    operations: {
      callbacks_pending: 4, callbacks_failed_today: 1,
      overflows_pending: 2, overflows_failed_today: 1,
      supervisor_requested: 1, supervisor_active: 1
    },
    queues: [
      queue('support', 'LED Support', waiting, 0, 0, 72, null, 58.3),
      queue('sales', 'Sales', 0, 2, 3, 0, 0, 96.8),
      queue('after-sales', 'After-sales', 2, 1, 1, 18, 120, 84.2),
      queue('priority', 'Priority service', 0, 1, 2, 0, 0, 100)
    ],
    alerts: [
      { code: 'queue_without_capacity', severity: 'critical', queue_id: 'support', value: waiting },
      { code: 'service_level_wait', severity: 'warning', queue_id: 'support', value: 72 },
      { code: 'callback_failures', severity: 'warning', queue_id: 'after-sales', value: 1 }
    ]
  };
}

function queue(
  id: string,
  name: string,
  waiting: number,
  agents: number,
  capacity: number,
  oldest: number,
  estimated: number | null,
  serviceLevel: number
) {
  return {
    queue_id: id, queue_name: name, status: 'active', routing_strategy: 'longest_idle',
    max_wait_seconds: 300, service_level_seconds: 20, waiting_count: waiting,
    offered_count: waiting ? 1 : 0, assigned_count: 0, answered_count: 1,
    available_agents: agents, available_capacity: capacity, oldest_wait_seconds: oldest,
    average_handle_seconds: 180, estimated_wait_seconds: estimated, answered_today: 42,
    answered_in_service_level_today: Math.floor(42 * serviceLevel / 100), abandoned_today: 3,
    timed_out_today: 1, overflowed_today: 0, average_wait_seconds_today: 18,
    service_level_percent_today: serviceLevel, callbacks_pending: id === 'after-sales' ? 2 : 0,
    callbacks_failed_today: id === 'after-sales' ? 1 : 0,
    overflows_pending: id === 'support' ? 2 : 0, overflows_failed_today: 0
  };
}

async function capture(page: Page, testInfo: TestInfo, filename: string): Promise<void> {
  const path = testInfo.outputPath(filename);
  mkdirSync(testInfo.outputDir, { recursive: true });
  await page.screenshot({ path, fullPage: true });
  await testInfo.attach(filename.replace(/\.png$/, ''), { path, contentType: 'image/png' });
}
