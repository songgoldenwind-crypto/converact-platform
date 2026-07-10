import { fileURLToPath } from 'node:url';
import {
  loadPlaywright,
  type BrowserAutomation,
  type BrowserLike,
  type PageLike
} from './livekit-browser-smoke.js';

export interface WebAssistBrowserSmokeConfig {
  frontendUrl: string;
  customerUrl: string;
  remoteSessionId: string;
  tenantId: string;
  engineerToken: string;
  engineerUserId: string;
  engineerEmail?: string;
  headless: boolean;
  timeoutMs: number;
}

export interface WebAssistBrowserSmokeStep {
  name: string;
}

export interface WebAssistBrowserSmokeResult {
  mode: 'web_assist_browser';
  remoteSessionId: string;
  customerUrl: string;
  steps: WebAssistBrowserSmokeStep[];
}

const defaultTimeoutMs = 30_000;
const browserArgs = [
  '--use-fake-ui-for-media-stream',
  '--use-fake-device-for-media-stream',
  '--auto-select-desktop-capture-source=Entire screen'
];

export function createWebAssistBrowserSmokeConfigFromEnv(
  env: NodeJS.ProcessEnv
): WebAssistBrowserSmokeConfig {
  const frontendUrl = trimTrailingSlash(env.OPC_FRONTEND_URL || env.OPC_APP_URL || '');
  if (!frontendUrl) throw new Error('OPC_FRONTEND_URL is required');

  const customerUrl = resolveCustomerUrl(env, frontendUrl);
  const parsedCustomerUrl = new URL(customerUrl);
  const remoteSessionId =
    env.OPC_WEB_ASSIST_REMOTE_SESSION_ID || parsedCustomerUrl.searchParams.get('remote_session_id') || '';
  const tenantId =
    env.OPC_WEB_ASSIST_TENANT_ID ||
    env.OPC_TENANT_ID ||
    parsedCustomerUrl.searchParams.get('tenant_id') ||
    '';
  const engineerToken = env.OPC_WEB_ASSIST_ENGINEER_TOKEN || '';
  const engineerUserId = env.OPC_WEB_ASSIST_ENGINEER_USER_ID || '';

  if (!remoteSessionId) {
    throw new Error('OPC_WEB_ASSIST_REMOTE_SESSION_ID or remote_session_id query is required');
  }
  if (!tenantId) throw new Error('OPC_WEB_ASSIST_TENANT_ID or OPC_TENANT_ID is required');
  if (!engineerToken) throw new Error('OPC_WEB_ASSIST_ENGINEER_TOKEN is required');
  if (!engineerUserId) throw new Error('OPC_WEB_ASSIST_ENGINEER_USER_ID is required');

  return {
    frontendUrl,
    customerUrl,
    remoteSessionId,
    tenantId,
    engineerToken,
    engineerUserId,
    engineerEmail: env.OPC_WEB_ASSIST_ENGINEER_EMAIL || undefined,
    headless: env.OPC_WEB_ASSIST_BROWSER_SMOKE_HEADLESS !== '0',
    timeoutMs: Number(env.OPC_WEB_ASSIST_BROWSER_SMOKE_TIMEOUT_MS || defaultTimeoutMs)
  };
}

export async function runWebAssistBrowserSmoke(
  config: WebAssistBrowserSmokeConfig,
  automation: BrowserAutomation
): Promise<WebAssistBrowserSmokeResult> {
  const steps: WebAssistBrowserSmokeStep[] = [];
  const browser = await automation.chromium.launch({
    headless: config.headless,
    args: browserArgs
  });

  try {
    const customer = await openCustomerRemoteAssistPage(browser, config);
    steps.push({ name: 'open_customer_remote_assist_page' });

    await customer.getByText('远程协助').waitFor({ timeout: config.timeoutMs });
    steps.push({ name: 'customer_page_loaded' });

    await customer.getByRole('button', { name: '授权协助' }).click({ timeout: config.timeoutMs });
    await customer.getByRole('button', { name: '共享屏幕' }).waitFor({ timeout: config.timeoutMs });
    steps.push({ name: 'customer_grants_consent' });

    await customer.getByRole('button', { name: '共享屏幕' }).click({ timeout: config.timeoutMs });
    await customer.getByRole('button', { name: '停止共享' }).waitFor({ timeout: config.timeoutMs });
    steps.push({ name: 'customer_starts_screen_share' });
    await customer.getByText('正在录屏').waitFor({ timeout: config.timeoutMs });
    steps.push({ name: 'customer_recording_started' });

    const engineer = await openEngineerObserverPage(browser, config);
    steps.push({ name: 'open_engineer_observer_page' });

    await engineer.getByText('远程协助观察').waitFor({ timeout: config.timeoutMs });
    steps.push({ name: 'engineer_observer_loaded' });

    await engineer
      .locator('[data-testid="remote-assist-observer-screen"] video')
      .first()
      .waitFor({ timeout: config.timeoutMs });
    steps.push({ name: 'engineer_has_screen_share_video' });

    await customer.getByRole('button', { name: '停止共享' }).click({ timeout: config.timeoutMs });
    await customer.getByRole('button', { name: '共享屏幕' }).waitFor({ timeout: config.timeoutMs });
    steps.push({ name: 'customer_stops_screen_share' });
    await customer.getByText('未录屏').waitFor({ timeout: config.timeoutMs });
    steps.push({ name: 'customer_recording_stopped' });

    return {
      mode: 'web_assist_browser',
      remoteSessionId: config.remoteSessionId,
      customerUrl: config.customerUrl,
      steps
    };
  } finally {
    await browser.close();
  }
}

async function openCustomerRemoteAssistPage(
  browser: BrowserLike,
  config: WebAssistBrowserSmokeConfig
): Promise<PageLike> {
  const context = await browser.newContext({
    permissions: ['camera', 'microphone'],
    viewport: { width: 390, height: 844 }
  });
  const page = await context.newPage();
  await page.goto(config.customerUrl, {
    waitUntil: 'networkidle',
    timeout: config.timeoutMs
  });
  return page;
}

async function openEngineerObserverPage(
  browser: BrowserLike,
  config: WebAssistBrowserSmokeConfig
): Promise<PageLike> {
  const context = await browser.newContext({
    permissions: ['camera', 'microphone'],
    viewport: { width: 1280, height: 900 }
  });
  await context.addInitScript(seedAuthStorage, {
    token: config.engineerToken,
    tenantId: config.tenantId,
    tenantName: config.tenantId,
    userId: config.engineerUserId,
    userEmail: config.engineerEmail || `${config.engineerUserId}@web-assist-smoke.local`
  });
  const page = await context.newPage();
  await page.goto(buildEngineerObserverUrl(config), {
    waitUntil: 'networkidle',
    timeout: config.timeoutMs
  });
  return page;
}

function buildEngineerObserverUrl(config: WebAssistBrowserSmokeConfig): string {
  const url = new URL('/remote-assist/observe', config.frontendUrl);
  url.searchParams.set('remote_session_id', config.remoteSessionId);
  return url.toString();
}

function seedAuthStorage(auth: {
  token: string;
  tenantId: string;
  tenantName: string;
  userId: string;
  userEmail: string;
}) {
  localStorage.setItem('opc_token', auth.token);
  localStorage.setItem('opc_tenant_id', auth.tenantId);
  localStorage.setItem('opc_tenant_name', auth.tenantName);
  localStorage.setItem('opc_user_id', auth.userId);
  localStorage.setItem('opc_user_email', auth.userEmail);
}

function resolveCustomerUrl(env: NodeJS.ProcessEnv, frontendUrl: string): string {
  const explicitUrl = env.OPC_WEB_ASSIST_CUSTOMER_URL || env.OPC_REMOTE_ASSIST_CUSTOMER_URL || '';
  if (!explicitUrl) {
    throw new Error('OPC_WEB_ASSIST_CUSTOMER_URL or OPC_REMOTE_ASSIST_CUSTOMER_URL is required');
  }
  return new URL(explicitUrl, frontendUrl).toString();
}

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, '');
}

async function main(): Promise<void> {
  const config = createWebAssistBrowserSmokeConfigFromEnv(process.env);
  const playwright = await loadPlaywright();
  const result = await runWebAssistBrowserSmoke(config, playwright);
  console.log(JSON.stringify(result, null, 2));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
