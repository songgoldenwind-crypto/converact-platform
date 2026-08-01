import { mkdirSync } from 'node:fs';

import { expect, test, type Browser, type BrowserContext, type Page, type TestInfo } from '@playwright/test';

test('controlled browser WebPhone lazy-loads and completes the single-call workflow', async ({ browser }, testInfo) => {
  const voice = await openVoice(browser, { width: 1440, height: 900 });
  try {
    expect(await loadedSipChunks(voice.page)).toEqual([]);
    await prepareWebPhone(voice.page);
    await expect(voice.page.getByRole('region', { name: 'SIP WebPhone' })).toBeVisible();
    expect((await loadedSipChunks(voice.page)).some((url) => url.includes('sip-phone-panel'))).toBe(true);
    expect((await voice.page.locator('body').textContent())?.includes('controlled-ephemeral-secret')).toBe(false);

    await voice.page.getByTitle('Register SIP phone').click();
    await expect(voice.page.getByText('registered', { exact: true })).toBeVisible();
    await voice.page.getByLabel('Audio input').selectOption('microphone-2');
    await voice.page.getByLabel('Audio output').selectOption('speaker-2');

    await voice.page.getByLabel('SIP destination').fill('1002');
    await voice.page.getByTitle('Dial SIP call').click();
    await expect(voice.page.getByText('outgoing', { exact: true })).toBeVisible();
    await emitCall(voice.page, 'active', 'sip:1002@pbx.example');
    await expect(voice.page.getByText('active', { exact: true })).toBeVisible();
    await voice.page.getByTitle('Mute microphone').click();
    await voice.page.getByTitle('Hold SIP call').click();
    await expect(voice.page.getByText('held', { exact: true })).toBeVisible();
    await voice.page.getByTitle('Send DTMF 5').click();
    await voice.page.getByTitle('Hang up SIP call').click();
    await expect(voice.page.locator('.sip-call-state')).toBeHidden();

    await emitCall(voice.page, 'incoming', 'sip:customer@example.com');
    await expect(voice.page.getByTitle('Answer incoming call')).toBeVisible();
    await voice.page.getByTitle('Answer incoming call').click();
    await expect(voice.page.getByText('active', { exact: true })).toBeVisible();
    await voice.page.getByTitle('Hang up SIP call').click();
    await emitCall(voice.page, 'incoming', 'sip:other@example.com');
    await expect(voice.page.getByTitle('Reject incoming call')).toBeVisible();
    await voice.page.getByTitle('Reject incoming call').click();

    await expect.poll(() => controlledActions(voice.page)).toEqual([
      'attach', 'connect', 'input:microphone-2', 'output:speaker-2', 'dial:1002',
      'muted:true', 'held:true', 'dtmf:5', 'hangup', 'answer', 'hangup', 'reject'
    ]);
    const layout = await voice.page.evaluate(() => {
      const pane = document.querySelector('.voice-workspace-pane')?.getBoundingClientRect();
      const phone = document.querySelector('.sip-phone')?.getBoundingClientRect();
      return {
        width: innerWidth,
        scrollWidth: document.documentElement.scrollWidth,
        pane: pane ? { left: pane.left, right: pane.right, bottom: pane.bottom } : null,
        phone: phone ? { left: phone.left, right: phone.right, bottom: phone.bottom } : null
      };
    });
    expect(layout.scrollWidth).toBe(layout.width);
    expect(layout.phone?.left).toBeGreaterThanOrEqual(layout.pane?.left || 0);
    expect(layout.phone?.right).toBeLessThanOrEqual(layout.pane?.right || layout.width);
    await capture(voice.page, testInfo, 'converact-sip-webphone-desktop.png');
  } finally {
    await voice.context.close();
  }
});

test('mobile WebPhone keeps controls inside the viewport', async ({ browser }, testInfo) => {
  const voice = await openVoice(browser, { width: 390, height: 844 });
  try {
    await prepareWebPhone(voice.page);
    await voice.page.getByTitle('Register SIP phone').click();
    await expect(voice.page.getByText('registered', { exact: true })).toBeVisible();
    await emitCall(voice.page, 'incoming', 'sip:customer@example.com');
    await expect(voice.page.getByTitle('Answer incoming call')).toBeVisible();
    const layout = await voice.page.evaluate(() => {
      const phone = document.querySelector('.sip-phone')?.getBoundingClientRect();
      const actions = document.querySelector('.sip-incoming-actions')?.getBoundingClientRect();
      return {
        width: innerWidth,
        scrollWidth: document.documentElement.scrollWidth,
        phone: phone ? { left: phone.left, right: phone.right, width: phone.width } : null,
        actions: actions ? { left: actions.left, right: actions.right, width: actions.width } : null
      };
    });
    expect(layout.scrollWidth).toBe(layout.width);
    expect(layout.phone?.left).toBeGreaterThanOrEqual(0);
    expect(layout.phone?.right).toBeLessThanOrEqual(layout.width);
    expect(layout.actions?.right).toBeLessThanOrEqual(layout.width);
    await capture(voice.page, testInfo, 'converact-sip-webphone-mobile.png');
  } finally {
    await voice.context.close();
  }
});

async function openVoice(
  browser: Browser,
  viewport: { width: number; height: number }
): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext({ viewport });
  await context.addInitScript(controlledSipInit);
  await context.addInitScript(() => {
    window.__CONVERACT_FABRIC_DEV_ACCESS_TOKEN__ = 'voice-token';
    window.__CONVERACT_FABRIC_DEV_IDENTITY__ = 'agent-a';
  });
  const page = await context.newPage();
  await page.route('**/converact-config.json', (route) => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify({ baseUrl: 'http://127.0.0.1:4179', tenantId: 'tenant-e2e' })
  }));
  await page.route('**/api/ivekit/events*', (route) => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify({ items: [], next_cursor: 'event-head', has_more: false, snapshot_required: false })
  }));
  await page.route('**/api/ivekit/voice/capabilities', (route) => route.fulfill({
    contentType: 'application/json', body: JSON.stringify({
      api_version: 'v1', tenant_id: 'tenant-e2e', capabilities: {
        deployment_profiles: true, sip_trunks: true, dids: true, extensions: true,
        extension_sessions: true, routes: true, calls: true, call_control: true,
        provider_events: true, recordings: true, parking_slots: true, livekit_sip_bridge: true,
        provider_webhooks: true
      }
    })
  }));
  await page.route('**/api/ivekit/voice/extensions/extension-a/session', (route) => route.fulfill({
    status: 201, contentType: 'application/json', body: JSON.stringify(sessionPlan())
  }));
  await page.goto('/?workspace=voice');
  await expect(page.locator('.voice-workspace-pane')).toBeVisible();
  return { context, page };
}

async function prepareWebPhone(page: Page): Promise<void> {
  await page.getByLabel('Extension ID').fill('extension-a');
  await page.getByTitle('Prepare extension session').click();
  await expect(page.getByText('Session ready')).toBeVisible();
}

function sessionPlan() {
  return {
    session_id: 'session-a', extension_id: 'extension-a', transport: 'wss',
    websocket_url: 'wss://pbx.example/ws', address_of_record: 'sip:1001@pbx.example',
    authorization_username: 'session-a', authorization_password: 'controlled-ephemeral-secret',
    display_name: 'Agent A', expires_at: '2099-07-13T09:05:00.000Z',
    register_expires_seconds: 300, ice_servers: [], capabilities: {
      incoming: true, outgoing: true, dtmf: true, hold: true, transfer: false,
      audio_input: true, audio_output: true
    }
  };
}

function controlledSipInit() {
  type PhoneState = {
    registration: string;
    call: string;
    remote_identity: string;
    muted: boolean;
    input_device_id: string;
    output_device_id: string;
    error: null;
  };
  const control = {
    actions: [] as string[],
    emit: (_patch: Partial<PhoneState>) => undefined
  };
  const emitters = new Set<(patch: Partial<PhoneState>) => void>();
  control.emit = (patch) => {
    for (const emit of emitters) emit(patch);
  };
  (window as unknown as { __CONVERACT_FABRIC_CONTROLLED_SIP__: typeof control }).__CONVERACT_FABRIC_CONTROLLED_SIP__ = control;
  window.__CONVERACT_FABRIC_DEV_SIP_WEBPHONE_FACTORY__ = () => {
    let state: PhoneState = {
      registration: 'idle', call: 'idle', remote_identity: '', muted: false,
      input_device_id: '', output_device_id: '', error: null
    };
    const listeners = new Set<(value: PhoneState) => void>();
    const emit = (patch: Partial<PhoneState>) => {
      state = { ...state, ...patch };
      for (const listener of listeners) listener(state);
    };
    emitters.add(emit);
    return {
      getSnapshot: () => state,
      subscribe(listener: (value: PhoneState) => void) { listeners.add(listener); listener(state); return () => listeners.delete(listener); },
      async connect() { control.actions.push('connect'); emit({ registration: 'registered' }); },
      async disconnect() { control.actions.push('disconnect'); emit({ registration: 'stopped', call: 'idle' }); },
      async dial(target: string) { control.actions.push(`dial:${target}`); emit({ call: 'outgoing', remote_identity: target }); },
      async answer() { control.actions.push('answer'); emit({ call: 'active' }); },
      async reject() { control.actions.push('reject'); emit({ call: 'idle', remote_identity: '' }); },
      async hangup() { control.actions.push('hangup'); emit({ call: 'idle', remote_identity: '' }); },
      async setMuted(muted: boolean) { control.actions.push(`muted:${muted}`); emit({ muted }); },
      async setHeld(held: boolean) { control.actions.push(`held:${held}`); emit({ call: held ? 'held' : 'active' }); },
      async sendDtmf(tones: string) { control.actions.push(`dtmf:${tones}`); },
      async setInputDevice(id: string) { control.actions.push(`input:${id}`); emit({ input_device_id: id }); },
      async setOutputDevice(id: string) { control.actions.push(`output:${id}`); emit({ output_device_id: id }); },
      async listAudioDevices() {
        return [
          { device_id: 'microphone-1', kind: 'audioinput', label: 'Desk microphone' },
          { device_id: 'microphone-2', kind: 'audioinput', label: 'Headset microphone' },
          { device_id: 'speaker-1', kind: 'audiooutput', label: 'Desk speaker' },
          { device_id: 'speaker-2', kind: 'audiooutput', label: 'Headset speaker' }
        ];
      },
      attachRemoteAudio() {
        if (!control.actions.includes('attach')) control.actions.push('attach');
      },
      async dispose() { return; }
    } as never;
  };
}

function emitCall(page: Page, call: string, remoteIdentity: string): Promise<void> {
  return page.evaluate(({ nextCall, identity }) => {
    (window as unknown as {
      __CONVERACT_FABRIC_CONTROLLED_SIP__: { emit(patch: Record<string, unknown>): void };
    }).__CONVERACT_FABRIC_CONTROLLED_SIP__.emit({ call: nextCall, remote_identity: identity });
  }, { nextCall: call, identity: remoteIdentity });
}

function controlledActions(page: Page): Promise<string[]> {
  return page.evaluate(() => [
    ...(window as unknown as { __CONVERACT_FABRIC_CONTROLLED_SIP__: { actions: string[] } })
      .__CONVERACT_FABRIC_CONTROLLED_SIP__.actions
  ]);
}

function loadedSipChunks(page: Page): Promise<string[]> {
  return page.evaluate(() => performance.getEntriesByType('resource')
    .map((entry) => entry.name)
    .filter((url) => /sip-phone-panel/.test(url)));
}

async function capture(page: Page, testInfo: TestInfo, filename: string): Promise<void> {
  const path = testInfo.outputPath(filename);
  mkdirSync(testInfo.outputDir, { recursive: true });
  await page.screenshot({ path, fullPage: true });
  await testInfo.attach(filename.replace(/\.png$/, ''), { path, contentType: 'image/png' });
}
