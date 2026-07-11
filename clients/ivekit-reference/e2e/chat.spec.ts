import { mkdirSync } from 'node:fs';

import { expect, test, type Browser, type BrowserContext, type Page, type TestInfo } from '@playwright/test';

import { startControlledChatServer, type ControlledChatServer } from './controlled-chat-server.js';

let controlled: ControlledChatServer;

test.beforeAll(async () => { controlled = await startControlledChatServer(); });
test.afterAll(async () => { await controlled.close(); });

test('two identities complete the iveKit IM workflow', async ({ browser }, testInfo) => {
  const agent = await openIdentity(browser, 'agent-1', 'token-agent');
  const customer = await openIdentity(browser, 'customer-1', 'token-customer');
  try {
    await expect(agent.page.locator('.connection')).toHaveText('online');
    await expect(customer.page.locator('.connection')).toHaveText('online');
    expect(controlled.state.tinodeConnections).toBeGreaterThanOrEqual(2);
    expect(controlled.state.tinodeAuthenticatedConnections).toBeGreaterThanOrEqual(2);
    expect(controlled.state.tinodeApiKeyConnections).toBeGreaterThanOrEqual(2);
    expect(controlled.state.tinodeSubscriptions).toBeGreaterThanOrEqual(2);
    expect(controlled.state.tinodeProtocolRejections).toBe(0);
    await expect(agent.page.locator('.participant').filter({ hasText: 'Northwind Customer' }).locator('.presence.online')).toBeVisible();

    await customer.page.getByLabel('Message').fill('typing draft');
    await expect(agent.page.getByText('customer · typing')).toBeVisible();
    await customer.page.getByLabel('Message').fill('');

    await sendText(agent.page, 'Hello from the agent');
    await expect(customer.page.getByText('Hello from the agent', { exact: true })).toBeVisible();
    await expect(agent.page.getByText('Read by 1')).toBeVisible();

    const messageEventCount = controlled.state.ivekitMessageCreatedEvents;
    const tinodePacketCount = controlled.state.tinodeDataPacketsSent;
    controlled.injectTinodeOnlyMessage('Tinode-only convergence');
    await expect(agent.page.getByText('Tinode-only convergence', { exact: true })).toBeVisible();
    await expect(customer.page.getByText('Tinode-only convergence', { exact: true })).toBeVisible();
    expect(controlled.state.ivekitMessageCreatedEvents).toBe(messageEventCount);
    expect(controlled.state.tinodeDataPacketsSent).toBeGreaterThan(tinodePacketCount);

    const agentMessageOnCustomer = customer.page.locator('article').filter({ hasText: 'Hello from the agent' });
    await agentMessageOnCustomer.getByTitle('Reply').click();
    await sendText(customer.page, 'Reply from the customer');
    await expect(agent.page.getByText('Reply from the customer', { exact: true })).toBeVisible();
    await expect(agent.page.getByText(/Reply · agent-1: Hello from the agent/)).toBeVisible();

    const initialOnCustomer = customer.page.locator('article').filter({
      has: customer.page.getByText('My display still shows the old campaign.', { exact: true })
    });
    await initialOnCustomer.getByTitle('Forward').click();
    await sendText(customer.page, 'Forwarded context');
    await expect(agent.page.getByText(/Forwarded · customer-1: My display still shows the old campaign/)).toBeVisible();

    const upload = agent.page.locator('input[type="file"]');
    await upload.setInputFiles({ name: 'evidence.txt', mimeType: 'text/plain', buffer: Buffer.from('controlled attachment') });
    await expect.poll(() => controlled.state.uploadCalls).toBe(1);
    await expect(agent.page.locator('.upload small')).toHaveText(/\d+%/);
    controlled.releasePendingUploads();
    await expect(agent.page.getByText('ready', { exact: true })).toBeVisible();
    await sendText(agent.page, 'Attachment evidence');
    await expect(customer.page.getByText('evidence.txt', { exact: true })).toBeVisible();
    expect(controlled.state.uploadCalls).toBe(1);

    const agentMessage = customer.page.locator('article').filter({
      has: customer.page.getByText('Hello from the agent', { exact: true })
    });
    await agentMessage.getByTitle('Add reaction').click();
    await customer.page.getByTitle('React with 👍').click();
    await expect(agent.page.getByRole('button', { name: '👍 1' })).toBeVisible();
    await agentMessage.getByTitle('Pin').click();
    await expect(agent.page.getByTitle('Go to pinned message')).toBeVisible();

    const editable = agent.page.locator('article').filter({
      has: agent.page.getByText('Hello from the agent', { exact: true })
    });
    await editable.getByTitle('Edit').click();
    const inlineEdit = agent.page.locator('.inline-edit');
    await inlineEdit.locator('textarea').fill('Hello from the agent, edited');
    await inlineEdit.getByRole('button', { name: 'Save' }).click();
    await expect(customer.page.locator('article').getByText('Hello from the agent, edited', { exact: true })).toBeVisible();

    const deletable = agent.page.locator('article').filter({ hasText: 'Attachment evidence' });
    await deletable.getByTitle('Delete').click();
    await expect(customer.page.locator('article').getByText('Message deleted', { exact: true })).toBeVisible();

    const initial = agent.page.locator('article').filter({ hasText: 'My display still shows the old campaign.' });
    await initial.getByRole('button', { name: 'Review 1 quality finding' }).click();
    await agent.page.getByLabel('Review reason').fill('Verified by the support supervisor');
    await agent.page.getByRole('button', { name: 'Confirm finding' }).click();
    await expect(agent.page.getByText('Confirmed').last()).toBeVisible();

    await captureDesktop(agent.page, testInfo);
    await verifyMobile(browser, controlled, testInfo);

    await agent.context.setOffline(true);
    await expect(agent.page.locator('.connection')).toHaveText('offline');
    await agent.context.setOffline(false);
    await expect(agent.page.locator('.connection')).toHaveText('online');

    agent.page.once('dialog', (dialog) => dialog.accept());
    await agent.page.getByTitle('Close session').click();
    await expect(agent.page.locator('.connection')).toHaveText('closed');
    await expect(customer.page.locator('.connection')).toHaveText('closed');
    await expect(agent.page.getByLabel('Message')).toBeDisabled();
    await expect.poll(() => controlled.state.tinodeActiveConnections).toBe(0);
    expect(controlled.state.tinodePublishAttempts).toBe(0);
    expect(controlled.state.sessionClosed).toBe(true);
  } finally {
    controlled.releasePendingUploads();
    await Promise.all([agent.context.close(), customer.context.close()]);
  }
});

async function openIdentity(
  browser: Browser,
  identity: string,
  token: string,
  viewport = { width: 1440, height: 900 }
): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext({ viewport });
  await context.addInitScript(({ accessToken, userIdentity }) => {
    window.__IVEKIT_DEV_ACCESS_TOKEN__ = accessToken;
    window.__IVEKIT_DEV_IDENTITY__ = userIdentity;
  }, { accessToken: token, userIdentity: identity });
  const page = await context.newPage();
  await page.route('**/ivekit-config.json', (route) => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify({ baseUrl: controlled.baseUrl, tenantId: 'tenant-e2e', websocketUrl: controlled.eventsUrl })
  }));
  await page.goto('/');
  await expect(page.getByRole('region', { name: 'Sessions' }).getByText('LED display support', { exact: true })).toBeVisible();
  return { context, page };
}

async function sendText(page: Page, body: string) {
  await page.getByLabel('Message').fill(body);
  await page.getByTitle('Send message').click();
  await expect(page.locator('article').getByText(body, { exact: true })).toBeVisible();
  await expect(page.getByLabel('Message')).toHaveValue('');
}

async function captureDesktop(page: Page, testInfo: TestInfo) {
  const layout = await page.evaluate(() => {
    const readRect = (selector: string) => {
      const value = document.querySelector(selector)?.getBoundingClientRect();
      return value ? { left: value.left, right: value.right, top: value.top, bottom: value.bottom } : { left: 0, right: 0, top: 0, bottom: 0 };
    };
    return {
      width: innerWidth,
      height: innerHeight,
      scrollWidth: document.documentElement.scrollWidth,
      workspaceWidth: document.querySelector('main')?.getBoundingClientRect().width || 0,
      detailVisible: getComputedStyle(document.querySelector('.detail-pane')!).display !== 'none',
      timeline: readRect('.timeline-pane'),
      detail: readRect('.detail-pane'),
      composer: readRect('.composer'),
      textLength: (document.querySelector('main')?.textContent || '').trim().length
    };
  });
  expect(layout.scrollWidth).toBe(layout.width);
  expect(layout.workspaceWidth).toBe(layout.width);
  expect(layout.detailVisible).toBe(true);
  expect(layout.textLength).toBeGreaterThan(100);
  expect(layout.composer.bottom).toBeLessThanOrEqual(layout.height);
  expect(layout.composer.left).toBe(layout.timeline.left);
  expect(Math.abs(layout.composer.right - layout.timeline.right)).toBeLessThanOrEqual(1);
  expect(layout.detail.left).toBeGreaterThanOrEqual(layout.timeline.right);
  const path = testInfo.outputPath('ivekit-im-desktop.png');
  mkdirSync(testInfo.outputDir, { recursive: true });
  await page.screenshot({ path, fullPage: true });
  await testInfo.attach('ivekit-im-desktop', { path, contentType: 'image/png' });
}

async function verifyMobile(browser: Browser, server: ControlledChatServer, testInfo: TestInfo) {
  const mobile = await openIdentity(browser, 'agent-1', 'token-agent', { width: 390, height: 844 });
  try {
    await expect(mobile.page.getByTitle('Show sessions')).toBeVisible();
    await mobile.page.getByTitle('Show messages').click();
    await expect(mobile.page.getByLabel('Message')).toBeVisible();
    const marker = mobile.page.getByRole('button', { name: 'Review 1 quality finding' });
    await marker.click();
    await expect(mobile.page.getByTitle('Close quality review')).toBeVisible();
    const dimensions = await mobile.page.evaluate(() => {
      const value = document.querySelector('.detail-pane.finding-open')?.getBoundingClientRect();
      return {
        width: innerWidth,
        height: innerHeight,
        scrollWidth: document.documentElement.scrollWidth,
        drawer: value ? { left: value.left, right: value.right, bottom: value.bottom } : { left: 0, right: 0, bottom: 0 },
        textLength: (document.querySelector('.finding-open')?.textContent || '').trim().length
      };
    });
    expect(dimensions.scrollWidth).toBe(dimensions.width);
    expect(dimensions.drawer.left).toBe(0);
    expect(dimensions.drawer.right).toBe(dimensions.width);
    expect(dimensions.drawer.bottom).toBe(dimensions.height);
    expect(dimensions.textLength).toBeGreaterThan(50);
    expect(server.state.findings.length).toBe(1);
    const path = testInfo.outputPath('ivekit-im-mobile.png');
    await mobile.page.screenshot({ path, fullPage: true });
    await testInfo.attach('ivekit-im-mobile', { path, contentType: 'image/png' });
  } finally {
    await mobile.context.close();
  }
}
