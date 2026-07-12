import { mkdirSync } from 'node:fs';

import { expect, test, type Browser, type BrowserContext, type Page, type TestInfo } from '@playwright/test';

import { startControlledRustDeskServer, type ControlledRustDeskServer } from './controlled-rustdesk-server.js';

let controlled: ControlledRustDeskServer;

test.describe.configure({ mode: 'serial' });
test.beforeAll(async () => { controlled = await startControlledRustDeskServer(); });
test.afterAll(async () => { await controlled.close(); });

test('controlled API enforces tenant and participant isolation and idempotent start retry', async ({ request }) => {
  controlled.failNextStart();
  const payload = {
    remote_session_id: 'remote-1', device_id: 'device-1', actor_identity: 'agent-1',
    permissions: ['view_screen', 'control_mouse_keyboard'], access_mode: 'attended'
  };
  const first = await request.post(`${controlled.baseUrl}/api/ivekit/rustdesk/gateway-sessions`, {
    headers: headers('token-agent'), data: payload
  });
  expect(first.status()).toBe(503);
  const retry = await request.post(`${controlled.baseUrl}/api/ivekit/rustdesk/gateway-sessions`, {
    headers: headers('token-agent'), data: payload
  });
  const replay = await request.post(`${controlled.baseUrl}/api/ivekit/rustdesk/gateway-sessions`, {
    headers: headers('token-agent'), data: payload
  });
  expect(retry.status()).toBe(201);
  expect(replay.status()).toBe(201);
  expect((await retry.json()).external_id).toBe((await replay.json()).external_id);
  expect(controlled.state.startRequests).toBe(3);
  expect(controlled.state.gateways.size).toBe(1);

  const participant = await request.get(`${controlled.baseUrl}/api/ivekit/rustdesk/devices/by-ref?business_ref_type=service_order&business_ref_id=SO-100`, {
    headers: headers('token-participant')
  });
  const outsider = await request.get(`${controlled.baseUrl}/api/ivekit/rustdesk/devices/by-ref?business_ref_type=service_order&business_ref_id=SO-100`, {
    headers: headers('token-outsider')
  });
  const crossTenant = await request.get(`${controlled.baseUrl}/api/ivekit/rustdesk/devices/by-ref?business_ref_type=service_order&business_ref_id=SO-100`, {
    headers: headers('token-other-tenant')
  });
  expect(participant.status()).toBe(200);
  expect(outsider.status()).toBe(403);
  expect(crossTenant.status()).toBe(403);
  const forgedActor = await request.post(`${controlled.baseUrl}/api/ivekit/rustdesk/gateway-sessions/gateway-1/events`, {
    headers: headers('token-agent'),
    data: { event_type: 'remote.rustdesk.operation.observed', actor_identity: 'participant-1', idempotency_key: 'forged-1' }
  });
  expect(forgedActor.status()).toBe(403);
});

test('agent completes controlled RustDesk launch control transfer audit end and disconnect flow', async ({ browser, request }, testInfo) => {
  const agent = await openIdentity(browser, 'agent-1', 'token-agent');
  try {
    await configureAndStart(agent.page);
    await expect(agent.page.getByText('2 scopes')).toBeVisible();
    await expect(agent.page.getByText('View screen, Keyboard and mouse')).toBeVisible();
    await expect(agent.page.getByText('rustdesk-id.example.test')).toBeVisible();
    await expect(agent.page.getByText('sha256:0011223344556677')).toBeVisible();
    await expect(agent.page.getByText('1 events')).toBeVisible();

    await agent.page.getByRole('button', { name: 'Open RustDesk' }).click();
    await expect.poll(() => openedProtocols(agent.page)).toHaveLength(1);
    const protocol = (await openedProtocols(agent.page))[0];
    expect(protocol).toMatch(/^rustdesk:\/\/connect\/123456789\?launch_token=/);
    const launchToken = new URL(protocol).searchParams.get('launch_token');
    expect(launchToken).toBeTruthy();
    const validLaunch = await request.get(`${controlled.baseUrl}/controlled/launch/${encodeURIComponent(launchToken!)}`);
    expect(validLaunch.status()).toBe(200);

    await agent.page.getByRole('button', { name: 'Take control' }).click();
    await expect(agent.page.getByText('agent-1', { exact: true })).toBeVisible();
    await agent.page.getByLabel('Transfer target identity').fill('participant-1');
    await agent.page.getByTitle('Transfer control').click();
    await expect(agent.page.getByText('participant-1', { exact: true })).toBeVisible();

    const eventInput = {
      event_type: 'remote.rustdesk.operation.observed', actor_identity: 'agent-1',
      idempotency_key: 'operation-view-1', metadata: {
        operation_id: 'operation-view-1', operation: 'view_screen', status: 'observed_succeeded',
        observer: 'qa', observed_at: '2026-07-12T08:00:00.000Z',
        evidence_refs: [{ type: 'qa_report', ref: 'evidence://controlled/view-1', sha256: 'b'.repeat(64) }]
      }
    };
    const eventUrl = `${controlled.baseUrl}/api/ivekit/rustdesk/gateway-sessions/gateway-1/events`;
    const observed = await request.post(eventUrl, { headers: headers('token-agent'), data: eventInput });
    const replayed = await request.post(eventUrl, { headers: headers('token-agent'), data: eventInput });
    expect(observed.status()).toBe(201);
    expect(replayed.status()).toBe(200);
    expect((await replayed.json()).replayed).toBe(true);
    await agent.page.getByTitle('Refresh remote state').click();
    await expect(agent.page.getByText('4 events')).toBeVisible();

    await captureLayout(agent.page, testInfo, 'ivekit-rustdesk-desktop');
    await assertNoTokenPersistence(agent.page, launchToken!);
    await agent.page.getByRole('button', { name: 'End', exact: true }).click();
    await expect(agent.page.locator('.remote-state')).toHaveText('ended');
    await agent.page.getByTitle('Refresh remote state').click();
    await expect(agent.page.getByText('Disconnect: pending')).toBeVisible();
    await agent.page.getByTitle('Refresh remote state').click();
    await expect(agent.page.getByText('Disconnect: observed_disconnected')).toBeVisible();
    const expiredLaunch = await request.get(`${controlled.baseUrl}/controlled/launch/${encodeURIComponent(launchToken!)}`);
    expect(expiredLaunch.status()).toBe(410);
  } finally {
    await agent.context.close();
  }
});

test('mobile UI suppresses a stale launch and reflects consent revocation', async ({ browser, request }, testInfo) => {
  const mobile = await openIdentity(browser, 'agent-1', 'token-agent', { width: 390, height: 844 });
  try {
    await configureAndStart(mobile.page);
    await captureLayout(mobile.page, testInfo, 'ivekit-rustdesk-mobile');
    const gateway = [...controlled.state.gateways.values()].find((item) => item.status === 'active');
    expect(gateway).toBeTruthy();
    const planResponse = await request.get(`${controlled.baseUrl}/api/ivekit/rustdesk/gateway-sessions/${gateway!.externalId}/launch`, {
      headers: headers('token-agent')
    });
    const oldLaunchUrl = String((await planResponse.json()).actions.open_url);
    controlled.rotateFingerprint(gateway!.externalId);
    await mobile.page.getByRole('button', { name: 'Open RustDesk' }).click();
    await expect(mobile.page.getByRole('alert')).toContainText('launch plan changed');
    expect(await openedProtocols(mobile.page)).toEqual([]);

    const revoked = await request.post(`${controlled.baseUrl}/api/ivekit/rustdesk/devices/device-1/access-policy/revoke`, {
      headers: { ...headers('token-agent'), 'idempotency-key': 'revoke-device-1' }, data: { reason: 'controlled E2E revoke' }
    });
    expect(revoked.status()).toBe(200);
    await mobile.page.getByTitle('Dismiss error').click();
    await mobile.page.getByTitle('Refresh remote state').click();
    await expect(mobile.page.locator('.remote-state')).toHaveText('ended');
    expect((await request.get(oldLaunchUrl)).status()).toBe(410);
  } finally {
    await mobile.context.close();
  }
});

test('business deep link unifies messages calls remote and browser history', async ({ browser }) => {
  const agent = await openIdentity(browser, 'agent-1', 'token-agent', { width: 1280, height: 800 }, {
    path: '/?business_ref_type=service_order&business_ref_id=SO-100',
    openRemote: false
  });
  try {
    await expect(agent.page.getByTitle('service_order: SO-100')).toBeVisible();
    await expect(agent.page.getByText('0M · 1C · 1R')).toBeVisible();
    await expect.poll(() => new URL(agent.page.url()).searchParams.get('call_id')).toBe('call-context');
    await expect.poll(() => new URL(agent.page.url()).searchParams.get('remote_session_id')).toBe('remote-1');
    await agent.page.getByTitle('Show authorization summary').click();
    await expect(agent.page.getByRole('complementary', { name: 'Business authorization summary' })).toContainText('view_screen');
    await expect(agent.page.getByRole('complementary', { name: 'Business authorization summary' })).toContainText('No gateway');
    await agent.page.getByRole('tab', { name: 'Activity' }).click();
    await expect(agent.page.getByText('remote.consent.granted')).toBeVisible();
    await expect(agent.page.getByText('evidence.video_recording')).toBeVisible();
    await agent.page.getByTitle('Close authorization summary').click();

    await agent.page.getByTitle('Show calls workspace').click();
    await expect(agent.page.getByText('Controlled completed call')).toBeVisible();
    await agent.page.getByTitle('Show remote workspace').click();
    await expect(agent.page.getByLabel('Business ID')).toHaveValue('SO-100');
    await expect(agent.page.getByLabel('Remote session ID')).toHaveValue('remote-1');

    await agent.page.goBack();
    await expect(agent.page.getByTitle('Show calls workspace')).toHaveAttribute('aria-pressed', 'true');
    await expect(agent.page.getByText('Controlled completed call')).toBeVisible();
    const layout = await agent.page.evaluate(() => ({ width: innerWidth, scrollWidth: document.documentElement.scrollWidth }));
    expect(layout.scrollWidth).toBe(layout.width);
  } finally {
    await agent.context.close();
  }
});

test('320px unified shell and context panel stay inside the viewport', async ({ browser }) => {
  const mobile = await openIdentity(browser, 'agent-1', 'token-agent', { width: 320, height: 700 }, {
    path: '/?business_ref_type=service_order&business_ref_id=SO-100',
    openRemote: false
  });
  try {
    await expect(mobile.page.getByTitle('Show authorization summary')).toBeVisible();
    await mobile.page.getByTitle('Show authorization summary').click();
    await expect(mobile.page.getByRole('complementary', { name: 'Business authorization summary' })).toBeVisible();
    const layout = await mobile.page.evaluate(() => {
      const panel = document.querySelector('.business-context-panel')?.getBoundingClientRect();
      return {
        width: innerWidth,
        scrollWidth: document.documentElement.scrollWidth,
        panel: panel ? { left: panel.left, right: panel.right, width: panel.width } : null
      };
    });
    expect(layout.scrollWidth).toBe(layout.width);
    expect(layout.panel).not.toBeNull();
    expect(layout.panel!.left).toBeGreaterThanOrEqual(0);
    expect(layout.panel!.right).toBeLessThanOrEqual(layout.width);
  } finally {
    await mobile.context.close();
  }
});

async function openIdentity(
  browser: Browser,
  identity: string,
  token: string,
  viewport = { width: 1440, height: 900 },
  options: { path?: string; openRemote?: boolean } = {}
): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext({ viewport });
  await context.addInitScript(({ accessToken, userIdentity }) => {
    const control = { opened: [] as string[] };
    (window as unknown as { __IVEKIT_CONTROLLED_RUSTDESK__: typeof control }).__IVEKIT_CONTROLLED_RUSTDESK__ = control;
    window.iveKitHost = {
      getAccessToken: () => accessToken,
      getIdentity: () => userIdentity,
      openExternal: (url) => { control.opened.push(url); }
    };
  }, { accessToken: token, userIdentity: identity });
  const page = await context.newPage();
  await page.route('**/ivekit-config.json', (route) => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify({ baseUrl: controlled.baseUrl, tenantId: 'tenant-e2e' })
  }));
  await page.goto(options.path || '/');
  if (options.openRemote !== false) {
    await page.getByTitle('Show remote workspace').click();
    await expect(page.getByText('Remote assistance')).toBeVisible();
  }
  return { context, page };
}

async function configureAndStart(page: Page): Promise<void> {
  await page.getByLabel('Business ID').fill('SO-100');
  await page.getByRole('button', { name: 'Resolve devices' }).click();
  await expect(page.getByLabel('Device')).toHaveValue('device-1');
  await page.getByLabel('Remote session ID').fill('remote-1');
  await page.getByRole('button', { name: 'Start session' }).click();
  await expect(page.locator('.remote-state')).toHaveText('active');
}

function headers(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}`, 'x-tenant-id': 'tenant-e2e' };
}

async function openedProtocols(page: Page): Promise<string[]> {
  return page.evaluate(() => (window as unknown as {
    __IVEKIT_CONTROLLED_RUSTDESK__: { opened: string[] }
  }).__IVEKIT_CONTROLLED_RUSTDESK__.opened);
}

async function assertNoTokenPersistence(page: Page, token: string): Promise<void> {
  const persistence = await page.evaluate(async () => ({
    local: Object.values(localStorage), session: Object.values(sessionStorage),
    databases: 'databases' in indexedDB ? (await indexedDB.databases()).map((item) => item.name) : [],
    html: document.documentElement.innerHTML
  }));
  expect(JSON.stringify({ local: persistence.local, session: persistence.session, databases: persistence.databases })).not.toContain(token);
  expect(persistence.html).not.toContain(token);
  expect(persistence.local).toEqual([]);
  expect(persistence.session).toEqual([]);
  expect(persistence.databases).toEqual([]);
}

async function captureLayout(page: Page, testInfo: TestInfo, name: string): Promise<void> {
  const end = page.getByRole('button', { name: 'End', exact: true });
  await end.scrollIntoViewIfNeeded();
  const layout = await page.evaluate(() => {
    const endButton = [...document.querySelectorAll('button')].find((item) => item.textContent?.trim() === 'End');
    const rect = endButton?.getBoundingClientRect();
    return {
      width: innerWidth, scrollWidth: document.documentElement.scrollWidth,
      end: rect ? { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom } : null,
      textLength: (document.querySelector('.remote-workspace-pane')?.textContent || '').trim().length
    };
  });
  expect(layout.scrollWidth).toBe(layout.width);
  expect(layout.textLength).toBeGreaterThan(120);
  expect(layout.end).not.toBeNull();
  expect(layout.end!.left).toBeGreaterThanOrEqual(0);
  expect(layout.end!.right).toBeLessThanOrEqual(layout.width);
  const path = testInfo.outputPath(`${name}.png`);
  mkdirSync(testInfo.outputDir, { recursive: true });
  await page.screenshot({ path, fullPage: true });
  await testInfo.attach(name, { path, contentType: 'image/png' });
}
