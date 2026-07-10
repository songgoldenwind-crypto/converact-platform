import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  createLiveKitCustomerBrowserSmokeConfigFromEnv,
  runLiveKitCustomerBrowserSmoke
} from '../scripts/livekit-customer-browser-smoke.js';
import type { BrowserAutomation } from '../scripts/livekit-browser-smoke.js';

test('customer browser smoke config accepts an explicit signed customer URL', () => {
  assert.throws(
    () => createLiveKitCustomerBrowserSmokeConfigFromEnv({}),
    /OPC_FRONTEND_URL is required/
  );

  const config = createLiveKitCustomerBrowserSmokeConfigFromEnv({
    OPC_FRONTEND_URL: 'http://localhost:5173/',
    OPC_CUSTOMER_VIDEO_URL: '/video?room=room-a&tenant_id=tenant-1&invite=sig',
    OPC_CUSTOMER_BROWSER_SMOKE_EXPECT_REMOTE: '1',
    OPC_CUSTOMER_BROWSER_SMOKE_EXPECT_SCREEN_SHARE: '1',
    OPC_CUSTOMER_BROWSER_SMOKE_HEADLESS: '0',
    OPC_CUSTOMER_BROWSER_SMOKE_TIMEOUT_MS: '12345'
  });

  assert.equal(config.frontendUrl, 'http://localhost:5173');
  assert.equal(
    config.customerUrl,
    'http://localhost:5173/video?room=room-a&tenant_id=tenant-1&invite=sig'
  );
  assert.equal(config.expectRemoteParticipant, true);
  assert.equal(config.expectScreenShare, true);
  assert.equal(config.headless, false);
  assert.equal(config.timeoutMs, 12345);
});

test('customer browser smoke config can build the customer URL from room parameters', () => {
  const config = createLiveKitCustomerBrowserSmokeConfigFromEnv({
    OPC_FRONTEND_URL: 'http://localhost:5173',
    OPC_CUSTOMER_BROWSER_SMOKE_ROOM_NAME: 'room-b',
    OPC_CUSTOMER_BROWSER_SMOKE_TENANT_ID: 'tenant-2',
    OPC_CUSTOMER_BROWSER_SMOKE_INVITE: 'sig-b',
    OPC_CUSTOMER_BROWSER_SMOKE_EXPIRES_AT: '1893456000000'
  });

  assert.equal(
    config.customerUrl,
    'http://localhost:5173/video?room=room-b&tenant_id=tenant-2&invite=sig-b&expires_at=1893456000000'
  );
});

test('customer browser smoke requires room and tenant when no explicit URL is supplied', () => {
  assert.throws(
    () =>
      createLiveKitCustomerBrowserSmokeConfigFromEnv({
        OPC_FRONTEND_URL: 'http://localhost:5173',
        OPC_CUSTOMER_BROWSER_SMOKE_ROOM_NAME: 'room-c'
      }),
    /OPC_CUSTOMER_BROWSER_SMOKE_TENANT_ID or OPC_TENANT_ID is required/
  );
});

test('customer browser smoke opens H5 video page and waits for connected states', async () => {
  const automation = createFakeAutomation();
  const result = await runLiveKitCustomerBrowserSmoke(
    {
      frontendUrl: 'http://localhost:5173',
      customerUrl: 'http://localhost:5173/video?room=room-a&tenant_id=tenant-1',
      headless: true,
      timeoutMs: 5000,
      expectRemoteParticipant: true,
      expectScreenShare: true
    },
    automation
  );

  assert.deepEqual(result.steps.map((step) => step.name), [
    'open_customer_video_page',
    'customer_page_loaded',
    'customer_connected_room',
    'customer_remote_present',
    'customer_has_remote_video',
    'customer_sees_screen_share',
    'customer_has_screen_share_video'
  ]);
  assert.equal(automation.browser.launchOptions.headless, true);
  assert.deepEqual(automation.browser.contextOptions.permissions, ['camera', 'microphone']);
  assert.ok(
    automation.page.actions.includes(
      'goto:http://localhost:5173/video?room=room-a&tenant_id=tenant-1'
    )
  );
  assert.ok(automation.page.actions.includes('wait:text:视频通话'));
  assert.ok(automation.page.actions.includes('wait:text:已连接房间'));
  assert.ok(automation.page.actions.includes('wait:text:/AI 数字人已接入|对方已接入/'));
  assert.ok(automation.page.actions.includes('wait:locator:[data-testid="customer-remote-video"] video:first'));
  assert.ok(automation.page.actions.includes('wait:text:屏幕共享'));
  assert.ok(automation.page.actions.includes('wait:locator:[data-testid="customer-remote-screen-share"] video:first'));
});

function createFakeAutomation(): BrowserAutomation & {
  browser: FakeBrowser;
  page: FakePage;
} {
  const page = new FakePage();
  const browser = new FakeBrowser(page);
  return {
    browser,
    page,
    chromium: {
      launch: async (options) => {
        browser.launchOptions = options;
        return browser;
      }
    }
  };
}

class FakeBrowser {
  launchOptions: Record<string, unknown> = {};
  contextOptions: Record<string, unknown> = {};

  constructor(private readonly page: FakePage) {}

  async newContext(options?: Record<string, unknown>) {
    this.contextOptions = options || {};
    return new FakeContext(this.page);
  }

  async close() {}
}

class FakeContext {
  constructor(private readonly page: FakePage) {}

  async addInitScript() {}

  async newPage() {
    return this.page;
  }

  async close() {}
}

class FakePage {
  actions: string[] = [];

  async goto(url: string) {
    this.actions.push(`goto:${url}`);
  }

  getByText(text: string | RegExp) {
    return new FakeLocator(this, `text:${String(text)}`);
  }

  getByRole(role: string, options: { name?: string | RegExp }) {
    return new FakeLocator(this, `${role}:${String(options.name || '')}`);
  }

  locator(selector: string) {
    return new FakeLocator(this, `locator:${selector}`);
  }

  record(action: string) {
    this.actions.push(action);
  }
}

class FakeLocator {
  constructor(
    private readonly page: FakePage,
    private readonly label: string
  ) {}

  first() {
    return new FakeLocator(this.page, `${this.label}:first`);
  }

  async click() {
    this.page.record(`click:${this.label}`);
  }

  async waitFor() {
    this.page.record(`wait:${this.label}`);
  }
}
