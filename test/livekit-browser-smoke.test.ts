import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  createLiveKitBrowserSmokeConfigFromEnv,
  loadPlaywright,
  runLiveKitBrowserSmoke,
  type BrowserAutomation
} from '../scripts/livekit-browser-smoke.js';

test('browser smoke config requires two authenticated agent browser sessions', () => {
  assert.throws(
    () => createLiveKitBrowserSmokeConfigFromEnv({}),
    /CONVERACT_FRONTEND_URL is required/
  );

  const config = createLiveKitBrowserSmokeConfigFromEnv({
    CONVERACT_FRONTEND_URL: 'http://localhost:5173/',
    CONVERACT_BROWSER_SMOKE_TENANT_ID: 'tenant-1',
    CONVERACT_BROWSER_SMOKE_AGENT_A_TOKEN: 'token-a',
    CONVERACT_BROWSER_SMOKE_AGENT_A_USER_ID: 'user-a',
    CONVERACT_BROWSER_SMOKE_AGENT_A_SEAT_ID: 'seat-a',
    CONVERACT_BROWSER_SMOKE_AGENT_B_TOKEN: 'token-b',
    CONVERACT_BROWSER_SMOKE_AGENT_B_USER_ID: 'user-b',
    CONVERACT_BROWSER_SMOKE_AGENT_B_SEAT_ID: 'seat-b',
    CONVERACT_BROWSER_SMOKE_SCREEN_SHARE: '1',
    CONVERACT_BROWSER_SMOKE_HEADLESS: '0',
    CONVERACT_BROWSER_SMOKE_TIMEOUT_MS: '12345'
  });

  assert.equal(config.frontendUrl, 'http://localhost:5173');
  assert.equal(config.tenantId, 'tenant-1');
  assert.equal(config.agentA.userId, 'user-a');
  assert.equal(config.agentA.seatId, 'seat-a');
  assert.equal(config.agentB.userId, 'user-b');
  assert.equal(config.agentB.seatId, 'seat-b');
  assert.equal(config.requireScreenShare, true);
  assert.equal(config.headless, false);
  assert.equal(config.timeoutMs, 12345);
});

test('browser smoke loader explains how to enable Playwright when it is not installed', async () => {
  await assert.rejects(
    () => loadPlaywright(async () => {
      throw new Error('Cannot find package playwright');
    }),
    /Install Playwright to run browser media smoke/
  );
});

test('browser smoke drives two workbench pages through intercom video and optional screen share', async () => {
  const automation = createFakeAutomation();
  const result = await runLiveKitBrowserSmoke(
    {
      frontendUrl: 'http://localhost:5173',
      tenantId: 'tenant-1',
      agentA: {
        token: 'token-a',
        userId: 'user-a',
        seatId: 'seat-a',
        email: 'a@example.test'
      },
      agentB: {
        token: 'token-b',
        userId: 'user-b',
        seatId: 'seat-b',
        email: 'b@example.test'
      },
      requireScreenShare: true,
      headless: true,
      timeoutMs: 5000
    },
    automation
  );

  assert.deepEqual(result.steps.map((step) => step.name), [
    'open_agent_a_workbench',
    'open_agent_b_workbench',
    'agent_a_start_video_intercom',
    'agent_b_receives_video_intercom',
    'agent_b_accepts_video_intercom',
    'both_agents_enter_video_call',
    'both_agents_have_video_elements',
    'agent_a_starts_screen_share',
    'agent_b_sees_screen_share',
    'agent_b_has_screen_share_video'
  ]);
  assert.equal(automation.browser.launchOptions.headless, true);
  assert.ok(automation.pages.agentA?.actions.includes('goto:http://localhost:5173/workbench'));
  assert.ok(automation.pages.agentB?.actions.includes('goto:http://localhost:5173/workbench'));
  assert.equal(automation.pages.agentA?.auth?.token, 'token-a');
  assert.equal(automation.pages.agentB?.auth?.seatId, 'seat-b');
  assert.ok(automation.pages.agentA?.actions.includes('click:button:视频:first'));
  assert.ok(automation.pages.agentB?.actions.includes('click:button:接听'));
  assert.ok(automation.pages.agentA?.actions.includes('wait:locator:[data-testid="agent-remote-video"] video:first'));
  assert.ok(automation.pages.agentB?.actions.includes('wait:locator:[data-testid="agent-remote-video"] video:first'));
  assert.ok(automation.pages.agentA?.actions.includes('click:button:共享屏幕'));
  assert.ok(automation.pages.agentB?.actions.includes('wait:locator:[data-testid="agent-remote-screen-share"] video:first'));
});

function createFakeAutomation(): BrowserAutomation & {
  browser: FakeBrowser;
  pages: { agentA?: FakePage; agentB?: FakePage };
} {
  const pages: { agentA?: FakePage; agentB?: FakePage } = {};
  const browser = new FakeBrowser(pages);
  return {
    browser,
    pages,
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
  private pageIndex = 0;

  constructor(private readonly pages: { agentA?: FakePage; agentB?: FakePage }) {}

  async newContext() {
    const pageName = this.pageIndex++ === 0 ? 'agentA' : 'agentB';
    const page = new FakePage(pageName);
    this.pages[pageName] = page;
    return new FakeContext(page);
  }

  async close() {}
}

class FakeContext {
  constructor(private readonly page: FakePage) {}

  async addInitScript(_script: unknown, auth: unknown) {
    this.page.auth = auth as FakeAuth;
  }

  async newPage() {
    return this.page;
  }

  async close() {}
}

interface FakeAuth {
  token: string;
  userId: string;
  tenantId: string;
  seatId: string;
}

class FakePage {
  actions: string[] = [];
  auth?: FakeAuth;

  constructor(private readonly name: string) {}

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
