import { resolveBrandEnv, resolveConveractEnv } from '../src/config/converact-env.js';
import { fileURLToPath } from 'node:url';

export interface BrowserSmokeAgentConfig {
  token: string;
  userId: string;
  seatId: string;
  email?: string;
}

export interface LiveKitBrowserSmokeConfig {
  frontendUrl: string;
  tenantId: string;
  agentA: BrowserSmokeAgentConfig;
  agentB: BrowserSmokeAgentConfig;
  headless: boolean;
  requireScreenShare: boolean;
  timeoutMs: number;
}

export interface LiveKitBrowserSmokeStep {
  name: string;
}

export interface LiveKitBrowserSmokeResult {
  mode: 'agent_intercom_browser';
  steps: LiveKitBrowserSmokeStep[];
}

export interface BrowserAutomation {
  chromium: {
    launch(options: Record<string, unknown>): Promise<BrowserLike>;
  };
}

export interface BrowserLike {
  newContext(options?: Record<string, unknown>): Promise<BrowserContextLike>;
  close(): Promise<void>;
}

export interface BrowserContextLike {
  addInitScript(script: unknown, arg?: unknown): Promise<void>;
  newPage(): Promise<PageLike>;
  close(): Promise<void>;
}

export interface PageLike {
  goto(url: string, options?: Record<string, unknown>): Promise<void>;
  getByText(text: string | RegExp, options?: Record<string, unknown>): LocatorLike;
  getByRole(role: string, options: { name?: string | RegExp }): LocatorLike;
  locator(selector: string): LocatorLike;
}

export interface LocatorLike {
  first(): LocatorLike;
  click(options?: Record<string, unknown>): Promise<void>;
  waitFor(options?: Record<string, unknown>): Promise<void>;
}

type DynamicImporter = (specifier: string) => Promise<unknown>;

const defaultTimeoutMs = 30_000;

export function createLiveKitBrowserSmokeConfigFromEnv(
  env: NodeJS.ProcessEnv
): LiveKitBrowserSmokeConfig {
  const frontendUrl = trimTrailingSlash(resolveBrandEnv(env, 'FRONTEND_URL') || resolveBrandEnv(env, 'APP_URL') || '');
  const tenantId = resolveBrandEnv(env, 'BROWSER_SMOKE_TENANT_ID') || resolveBrandEnv(env, 'TENANT_ID') || '';
  if (!frontendUrl) throw new Error('CONVERACT_FRONTEND_URL is required');
  if (!tenantId) throw new Error('CONVERACT_BROWSER_SMOKE_TENANT_ID or CONVERACT_TENANT_ID is required');

  return {
    frontendUrl,
    tenantId,
    agentA: readAgentConfig(env, 'A'),
    agentB: readAgentConfig(env, 'B'),
    headless: resolveBrandEnv(env, 'BROWSER_SMOKE_HEADLESS') !== '0',
    requireScreenShare: resolveBrandEnv(env, 'BROWSER_SMOKE_SCREEN_SHARE') === '1',
    timeoutMs: Number(resolveBrandEnv(env, 'BROWSER_SMOKE_TIMEOUT_MS') || defaultTimeoutMs)
  };
}

export async function loadPlaywright(
  importer: DynamicImporter = dynamicImport
): Promise<BrowserAutomation> {
  try {
    const mod = await importer('playwright');
    if (!isBrowserAutomation(mod)) throw new Error('playwright module is invalid');
    return mod;
  } catch (error) {
    throw new Error(
      `Install Playwright to run browser media smoke: npm i -D playwright && npx playwright install chromium. ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

export async function runLiveKitBrowserSmoke(
  config: LiveKitBrowserSmokeConfig,
  automation: BrowserAutomation
): Promise<LiveKitBrowserSmokeResult> {
  const steps: LiveKitBrowserSmokeStep[] = [];
  const browser = await automation.chromium.launch({
    headless: config.headless,
    args: [
      '--use-fake-ui-for-media-stream',
      '--use-fake-device-for-media-stream',
      '--auto-select-desktop-capture-source=Entire screen'
    ]
  });

  try {
    const agentA = await openAuthedWorkbench(browser, config, config.agentA);
    steps.push({ name: 'open_agent_a_workbench' });

    const agentB = await openAuthedWorkbench(browser, config, config.agentB);
    steps.push({ name: 'open_agent_b_workbench' });

    await agentA.getByRole('button', { name: '视频' }).first().click({ timeout: config.timeoutMs });
    steps.push({ name: 'agent_a_start_video_intercom' });

    await agentB.getByText(/坐席呼叫.*视频/).waitFor({ timeout: config.timeoutMs });
    steps.push({ name: 'agent_b_receives_video_intercom' });

    await agentB.getByRole('button', { name: '接听' }).click({ timeout: config.timeoutMs });
    steps.push({ name: 'agent_b_accepts_video_intercom' });

    await agentA.getByText('视频通话').waitFor({ timeout: config.timeoutMs });
    await agentB.getByText('视频通话').waitFor({ timeout: config.timeoutMs });
    steps.push({ name: 'both_agents_enter_video_call' });

    await agentA.locator('[data-testid="agent-remote-video"] video').first().waitFor({ timeout: config.timeoutMs });
    await agentB.locator('[data-testid="agent-remote-video"] video').first().waitFor({ timeout: config.timeoutMs });
    steps.push({ name: 'both_agents_have_video_elements' });

    if (config.requireScreenShare) {
      await agentA.getByRole('button', { name: '共享屏幕' }).click({ timeout: config.timeoutMs });
      await agentA.getByRole('button', { name: '停止共享' }).waitFor({ timeout: config.timeoutMs });
      steps.push({ name: 'agent_a_starts_screen_share' });

      await agentB.getByText('屏幕共享').waitFor({ timeout: config.timeoutMs });
      steps.push({ name: 'agent_b_sees_screen_share' });

      await agentB.locator('[data-testid="agent-remote-screen-share"] video').first().waitFor({ timeout: config.timeoutMs });
      steps.push({ name: 'agent_b_has_screen_share_video' });
    }

    return {
      mode: 'agent_intercom_browser',
      steps
    };
  } finally {
    await browser.close();
  }
}

async function openAuthedWorkbench(
  browser: BrowserLike,
  config: LiveKitBrowserSmokeConfig,
  agent: BrowserSmokeAgentConfig
): Promise<PageLike> {
  const context = await browser.newContext({
    permissions: ['camera', 'microphone'],
    viewport: { width: 1280, height: 900 }
  });
  await context.addInitScript(seedAuthStorage, {
    token: agent.token,
    tenantId: config.tenantId,
    tenantName: config.tenantId,
    userId: agent.userId,
    userEmail: agent.email || `${agent.userId}@browser-smoke.local`,
    seatId: agent.seatId
  });
  const page = await context.newPage();
  await page.goto(new URL('/workbench', config.frontendUrl).toString(), {
    waitUntil: 'networkidle',
    timeout: config.timeoutMs
  });
  await page.getByText('坐席工作台').waitFor({ timeout: config.timeoutMs });
  return page;
}

function seedAuthStorage(auth: {
  token: string;
  tenantId: string;
  tenantName: string;
  userId: string;
  userEmail: string;
  seatId: string;
}) {
  localStorage.setItem('converact_token', auth.token);
  localStorage.setItem('opc_tenant_id', auth.tenantId);
  localStorage.setItem('opc_tenant_name', auth.tenantName);
  localStorage.setItem('opc_user_id', auth.userId);
  localStorage.setItem('opc_user_email', auth.userEmail);
  localStorage.setItem('opc_seat_id', auth.seatId);
}

function readAgentConfig(env: NodeJS.ProcessEnv, suffix: 'A' | 'B'): BrowserSmokeAgentConfig {
  const token = resolveConveractEnv(env, `CONVERACT_BROWSER_SMOKE_AGENT_${suffix}_TOKEN`) || '';
  const userId = resolveConveractEnv(env, `CONVERACT_BROWSER_SMOKE_AGENT_${suffix}_USER_ID`) || '';
  const seatId = resolveConveractEnv(env, `CONVERACT_BROWSER_SMOKE_AGENT_${suffix}_SEAT_ID`) || '';
  const email = resolveConveractEnv(env, `CONVERACT_BROWSER_SMOKE_AGENT_${suffix}_EMAIL`) || undefined;
  if (!token) throw new Error(`CONVERACT_BROWSER_SMOKE_AGENT_${suffix}_TOKEN is required`);
  if (!userId) throw new Error(`CONVERACT_BROWSER_SMOKE_AGENT_${suffix}_USER_ID is required`);
  if (!seatId) throw new Error(`CONVERACT_BROWSER_SMOKE_AGENT_${suffix}_SEAT_ID is required`);
  return { token, userId, seatId, email };
}

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, '');
}

function isBrowserAutomation(value: unknown): value is BrowserAutomation {
  return Boolean(
    value &&
      typeof value === 'object' &&
      'chromium' in value &&
      (value as { chromium?: { launch?: unknown } }).chromium &&
      typeof (value as { chromium: { launch?: unknown } }).chromium.launch === 'function'
  );
}

const dynamicImport: DynamicImporter = (specifier) => {
  const fn = new Function('specifier', 'return import(specifier)') as DynamicImporter;
  return fn(specifier);
};

async function main(): Promise<void> {
  const config = createLiveKitBrowserSmokeConfigFromEnv(process.env);
  const playwright = await loadPlaywright();
  const result = await runLiveKitBrowserSmoke(config, playwright);
  console.log(JSON.stringify(result, null, 2));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
