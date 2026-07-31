import { resolveBrandEnv } from '../src/config/converact-env.js';
import { fileURLToPath } from 'node:url';
import { loadPlaywright, type BrowserAutomation } from './livekit-browser-smoke.js';

export interface LiveKitCustomerBrowserSmokeConfig {
  frontendUrl: string;
  customerUrl: string;
  headless: boolean;
  timeoutMs: number;
  expectRemoteParticipant: boolean;
  expectScreenShare: boolean;
}

export interface LiveKitCustomerBrowserSmokeStep {
  name: string;
}

export interface LiveKitCustomerBrowserSmokeResult {
  mode: 'customer_h5_browser';
  customerUrl: string;
  steps: LiveKitCustomerBrowserSmokeStep[];
}

const defaultTimeoutMs = 30_000;

export function createLiveKitCustomerBrowserSmokeConfigFromEnv(
  env: NodeJS.ProcessEnv
): LiveKitCustomerBrowserSmokeConfig {
  const frontendUrl = trimTrailingSlash(resolveBrandEnv(env, 'FRONTEND_URL') || resolveBrandEnv(env, 'APP_URL') || '');
  if (!frontendUrl) throw new Error('CONVERACT_FRONTEND_URL is required');

  return {
    frontendUrl,
    customerUrl: resolveCustomerUrl(env, frontendUrl),
    headless: resolveBrandEnv(env, 'CUSTOMER_BROWSER_SMOKE_HEADLESS') !== '0',
    timeoutMs: Number(resolveBrandEnv(env, 'CUSTOMER_BROWSER_SMOKE_TIMEOUT_MS') || defaultTimeoutMs),
    expectRemoteParticipant:
      resolveBrandEnv(env, 'CUSTOMER_BROWSER_SMOKE_EXPECT_REMOTE') === '1' ||
      resolveBrandEnv(env, 'CUSTOMER_BROWSER_SMOKE_EXPECT_AVATAR') === '1',
    expectScreenShare: resolveBrandEnv(env, 'CUSTOMER_BROWSER_SMOKE_EXPECT_SCREEN_SHARE') === '1'
  };
}

export async function runLiveKitCustomerBrowserSmoke(
  config: LiveKitCustomerBrowserSmokeConfig,
  automation: BrowserAutomation
): Promise<LiveKitCustomerBrowserSmokeResult> {
  const steps: LiveKitCustomerBrowserSmokeStep[] = [];
  const browser = await automation.chromium.launch({
    headless: config.headless,
    args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream']
  });

  try {
    const context = await browser.newContext({
      permissions: ['camera', 'microphone'],
      viewport: { width: 390, height: 844 }
    });
    const page = await context.newPage();

    await page.goto(config.customerUrl, {
      waitUntil: 'networkidle',
      timeout: config.timeoutMs
    });
    steps.push({ name: 'open_customer_video_page' });

    await page.getByText('视频通话').waitFor({ timeout: config.timeoutMs });
    steps.push({ name: 'customer_page_loaded' });

    await page.getByText('已连接房间').waitFor({ timeout: config.timeoutMs });
    steps.push({ name: 'customer_connected_room' });

    if (config.expectRemoteParticipant) {
      await page.getByText(/AI 数字人已接入|对方已接入/).waitFor({
        timeout: config.timeoutMs
      });
      steps.push({ name: 'customer_remote_present' });
      await page.locator('[data-testid="customer-remote-video"] video').first().waitFor({
        timeout: config.timeoutMs
      });
      steps.push({ name: 'customer_has_remote_video' });
    }

    if (config.expectScreenShare) {
      await page.getByText('屏幕共享').waitFor({ timeout: config.timeoutMs });
      steps.push({ name: 'customer_sees_screen_share' });
      await page.locator('[data-testid="customer-remote-screen-share"] video').first().waitFor({
        timeout: config.timeoutMs
      });
      steps.push({ name: 'customer_has_screen_share_video' });
    }

    return {
      mode: 'customer_h5_browser',
      customerUrl: config.customerUrl,
      steps
    };
  } finally {
    await browser.close();
  }
}

function resolveCustomerUrl(env: NodeJS.ProcessEnv, frontendUrl: string): string {
  const explicitUrl = resolveBrandEnv(env, 'CUSTOMER_VIDEO_URL') || resolveBrandEnv(env, 'CUSTOMER_BROWSER_SMOKE_URL') || '';
  if (explicitUrl) return new URL(explicitUrl, frontendUrl).toString();

  const roomName =
    resolveBrandEnv(env, 'CUSTOMER_BROWSER_SMOKE_ROOM_NAME') || resolveBrandEnv(env, 'CUSTOMER_VIDEO_ROOM_NAME') || '';
  const tenantId =
    resolveBrandEnv(env, 'CUSTOMER_BROWSER_SMOKE_TENANT_ID') || resolveBrandEnv(env, 'TENANT_ID') || '';
  if (!roomName) throw new Error('CONVERACT_CUSTOMER_BROWSER_SMOKE_ROOM_NAME is required');
  if (!tenantId) {
    throw new Error('CONVERACT_CUSTOMER_BROWSER_SMOKE_TENANT_ID or CONVERACT_TENANT_ID is required');
  }

  const url = new URL('/video', frontendUrl);
  url.searchParams.set('room', roomName);
  url.searchParams.set('tenant_id', tenantId);
  const invite = resolveBrandEnv(env, 'CUSTOMER_BROWSER_SMOKE_INVITE') || '';
  const expiresAt = resolveBrandEnv(env, 'CUSTOMER_BROWSER_SMOKE_EXPIRES_AT') || '';
  if (invite) url.searchParams.set('invite', invite);
  if (expiresAt) url.searchParams.set('expires_at', expiresAt);
  return url.toString();
}

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, '');
}

async function main(): Promise<void> {
  const config = createLiveKitCustomerBrowserSmokeConfigFromEnv(process.env);
  const playwright = await loadPlaywright();
  const result = await runLiveKitCustomerBrowserSmoke(config, playwright);
  console.log(JSON.stringify(result, null, 2));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
