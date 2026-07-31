import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import {
  createWebAssistBrowserSmokeConfigFromEnv,
  runWebAssistBrowserSmoke
} from '../scripts/web-assist-browser-smoke.js';
import type { BrowserAutomation } from '../scripts/livekit-browser-smoke.js';

test('web assist browser smoke config resolves signed customer and engineer observer inputs', () => {
  assert.throws(
    () => createWebAssistBrowserSmokeConfigFromEnv({}),
    /OPC_FRONTEND_URL is required/
  );

  const config = createWebAssistBrowserSmokeConfigFromEnv({
    OPC_FRONTEND_URL: 'http://localhost:5173/',
    OPC_WEB_ASSIST_CUSTOMER_URL:
      '/remote-assist/session?tenant_id=tenant-1&remote_session_id=remote-1&token=signed-customer',
    OPC_WEB_ASSIST_ENGINEER_TOKEN: 'engineer-token',
    OPC_WEB_ASSIST_ENGINEER_USER_ID: 'engineer-1',
    OPC_TENANT_ID: 'tenant-1',
    OPC_WEB_ASSIST_BROWSER_SMOKE_HEADLESS: '0',
    OPC_WEB_ASSIST_BROWSER_SMOKE_TIMEOUT_MS: '12345'
  });

  assert.equal(config.frontendUrl, 'http://localhost:5173');
  assert.equal(
    config.customerUrl,
    'http://localhost:5173/remote-assist/session?tenant_id=tenant-1&remote_session_id=remote-1&token=signed-customer'
  );
  assert.equal(config.remoteSessionId, 'remote-1');
  assert.equal(config.tenantId, 'tenant-1');
  assert.equal(config.engineerToken, 'engineer-token');
  assert.equal(config.engineerUserId, 'engineer-1');
  assert.equal(config.headless, false);
  assert.equal(config.timeoutMs, 12345);
});

test('web assist browser smoke config requires a remote session id', () => {
  assert.throws(
    () =>
      createWebAssistBrowserSmokeConfigFromEnv({
        OPC_FRONTEND_URL: 'http://localhost:5173',
        OPC_WEB_ASSIST_CUSTOMER_URL: '/remote-assist/session?tenant_id=tenant-1&token=signed-customer',
        OPC_WEB_ASSIST_ENGINEER_TOKEN: 'engineer-token',
        OPC_WEB_ASSIST_ENGINEER_USER_ID: 'engineer-1',
        OPC_TENANT_ID: 'tenant-1'
      }),
    /OPC_WEB_ASSIST_REMOTE_SESSION_ID or remote_session_id query is required/
  );
});

test('web assist browser smoke opens customer share and engineer observer pages', async () => {
  const automation = createFakeAutomation();
  const result = await runWebAssistBrowserSmoke(
    {
      frontendUrl: 'http://localhost:5173',
      customerUrl:
        'http://localhost:5173/remote-assist/session?tenant_id=tenant-1&remote_session_id=remote-1&token=signed-customer',
      remoteSessionId: 'remote-1',
      tenantId: 'tenant-1',
      engineerToken: 'engineer-token',
      engineerUserId: 'engineer-1',
      engineerEmail: 'engineer@example.com',
      headless: true,
      timeoutMs: 5000
    },
    automation
  );

  assert.deepEqual(result.steps.map((step) => step.name), [
    'open_customer_remote_assist_page',
    'customer_page_loaded',
    'customer_grants_consent',
    'customer_starts_screen_share',
    'customer_recording_started',
    'open_engineer_observer_page',
    'engineer_observer_loaded',
    'engineer_has_screen_share_video',
    'customer_stops_screen_share',
    'customer_recording_stopped'
  ]);
  assert.equal(result.mode, 'web_assist_browser');
  assert.equal(result.remoteSessionId, 'remote-1');
  assert.equal(result.customerUrl, automation.customerPage.actions[0]?.replace('goto:', ''));
  assert.equal(automation.browser.launchOptions.headless, true);
  assert.deepEqual(automation.browser.launchOptions.args, [
    '--use-fake-ui-for-media-stream',
    '--use-fake-device-for-media-stream',
    '--auto-select-desktop-capture-source=Entire screen'
  ]);
  assert.deepEqual(automation.customerContext.contextOptions.permissions, ['camera', 'microphone']);
  assert.ok(automation.customerPage.actions.includes('wait:text:远程协助'));
  assert.ok(automation.customerPage.actions.includes('click:button:授权协助'));
  assert.ok(automation.customerPage.actions.includes('wait:button:共享屏幕'));
  assert.ok(automation.customerPage.actions.includes('click:button:共享屏幕'));
  assert.ok(automation.customerPage.actions.includes('wait:button:停止共享'));
  assert.ok(automation.customerPage.actions.includes('wait:text:正在录屏'));
  assert.ok(automation.customerPage.actions.includes('click:button:停止共享'));
  assert.ok(automation.customerPage.actions.includes('wait:text:未录屏'));
  assert.ok(
    automation.engineerPage.actions.includes(
      'goto:http://localhost:5173/remote-assist/observe?remote_session_id=remote-1'
    )
  );
  assert.ok(automation.engineerContext.initScriptArgs.some((arg) => arg.token === 'engineer-token'));
  assert.ok(automation.engineerPage.actions.includes('wait:text:远程协助观察'));
  assert.ok(
    automation.engineerPage.actions.includes(
      'wait:locator:[data-testid="remote-assist-observer-screen"] video:first'
    )
  );
});

test('package exposes the web assist browser smoke command', () => {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
    scripts?: Record<string, string>;
  };

  assert.equal(pkg.scripts?.['smoke:media:web-assist-browser'], 'tsx scripts/web-assist-browser-smoke.ts');
});

function createFakeAutomation(): BrowserAutomation & {
  browser: FakeBrowser;
  customerContext: FakeContext;
  engineerContext: FakeContext;
  customerPage: FakePage;
  engineerPage: FakePage;
} {
  const customerPage = new FakePage();
  const engineerPage = new FakePage();
  const customerContext = new FakeContext(customerPage);
  const engineerContext = new FakeContext(engineerPage);
  const browser = new FakeBrowser([customerContext, engineerContext]);
  return {
    browser,
    customerContext,
    engineerContext,
    customerPage,
    engineerPage,
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

  constructor(private readonly contexts: FakeContext[]) {}

  async newContext(options?: Record<string, unknown>) {
    const context = this.contexts.shift();
    assert.ok(context, 'fake context available');
    context.contextOptions = options || {};
    return context;
  }

  async close() {}
}

class FakeContext {
  contextOptions: Record<string, unknown> = {};
  initScriptArgs: Array<Record<string, string>> = [];

  constructor(private readonly page: FakePage) {}

  async addInitScript(_script: unknown, arg?: unknown) {
    if (arg && typeof arg === 'object') {
      this.initScriptArgs.push(arg as Record<string, string>);
    }
  }

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
