import { mkdirSync } from 'node:fs';

import { expect, test, type Browser, type BrowserContext, type Page, type TestInfo } from '@playwright/test';

import { startControlledMediaServer, type ControlledMediaServer } from './controlled-media-server.js';

let controlled: ControlledMediaServer;

test.beforeAll(async () => { controlled = await startControlledMediaServer(); });
test.afterAll(async () => { await controlled.close(); });

test('two identities complete the controlled iveKit media workflow', async ({ browser }, testInfo) => {
  const host = await openIdentity(browser, 'host-1', 'token-host', 'call-main');
  const participant = await openIdentity(browser, 'participant-1', 'token-participant', 'call-main');
  try {
    await expect(host.page.locator('.call-status')).toHaveText('Created');
    await host.page.getByRole('button', { name: 'Ring' }).click();
    await expect(host.page.locator('.call-status')).toHaveText('Ringing');
    await expect(participant.page.locator('.call-status')).toHaveText('Ringing');

    await participant.page.getByRole('button', { name: 'Accept' }).click();
    const setup = participant.page.getByRole('region', { name: 'Call setup' });
    await expect(setup).toBeVisible();
    await expect(setup.getByText('Devices ready')).toBeVisible();
    await setup.getByLabel('Microphone', { exact: true }).selectOption('microphone-2');
    await setup.getByLabel('Camera', { exact: true }).selectOption('camera-2');
    await setup.getByRole('button', { name: 'Accept' }).click();

    await expect(participant.page.locator('.call-status')).toHaveText('Active');
    await expect(host.page.locator('.call-status')).toHaveText('Active');
    await expect(host.page.locator('.participant-grid')).toBeVisible();
    await expect(host.page.getByLabel('LED Customer camera')).toBeVisible();
    expect(controlled.state.joins.sort()).toEqual(['call-main:host-1', 'call-main:participant-1']);

    const toolbarBefore = await rect(host.page, '.media-toolbar');
    await host.page.getByTitle('Turn on microphone').click();
    await host.page.getByTitle('Turn on camera').click();
    await expect(host.page.getByTitle('Turn off microphone')).toBeVisible();
    await expect(host.page.getByTitle('Turn off camera')).toBeVisible();
    expect(await rect(host.page, '.media-toolbar')).toEqual(toolbarBefore);

    await host.page.getByTitle('Speaker layout').click();
    await expect(host.page.locator('.speaker-layout')).toBeVisible();
    await host.page.getByTitle('Grid layout').click();
    await expect(host.page.locator('.participant-grid')).toBeVisible();

    await host.page.getByTitle('Choose devices').click();
    const devices = host.page.getByRole('region', { name: 'Call setup' });
    await expect(devices.getByText('Devices ready')).toBeVisible();
    await devices.getByLabel('Microphone', { exact: true }).selectOption('microphone-2');
    await devices.getByLabel('Camera', { exact: true }).selectOption('camera-2');
    await devices.getByLabel('Speaker', { exact: true }).selectOption('speaker-2');
    await devices.getByRole('button', { name: 'Apply' }).click();
    await expect(devices).toBeHidden();
    await expect.poll(() => controlledBrowserState(host.page, 'switchedDevices')).toEqual([
      'audioinput:microphone-2',
      'videoinput:camera-2',
      'audiooutput:speaker-2'
    ]);

    host.page.once('dialog', (dialog) => dialog.accept());
    await host.page.getByTitle('Mute LED Customer').click();
    await expect.poll(() => controlled.state.moderation).toContain('call-main:mute:participant-1');

    await host.page.getByTitle('Share screen').click();
    await expect(host.page.locator('.screen-share-stage')).toBeVisible();
    await expect(host.page.getByLabel('Shared screen video from host-1')).toBeVisible();
    const video = await host.page.getByLabel('Shared screen video from host-1').evaluate((element) => ({
      width: element.getBoundingClientRect().width,
      height: element.getBoundingClientRect().height,
      poster: (element as HTMLVideoElement).poster,
      background: getComputedStyle(element).backgroundColor
    }));
    expect(video.width).toBeGreaterThan(100);
    expect(video.height).toBeGreaterThan(100);
    expect(video.poster || video.background !== 'rgba(0, 0, 0, 0)').toBeTruthy();

    await host.page.getByTitle('Open recordings').click();
    await host.page.getByTitle('Start recording').click();
    await expect(host.page.getByText('evidence-1')).toBeVisible();
    await expect(host.page.getByText('Recording', { exact: true })).toBeVisible();
    await host.page.getByTitle('Stop recording').click();
    await expect(host.page.getByText('Completed', { exact: true })).toBeVisible();
    expect(controlled.state.recordingStarts).toBe(1);
    expect(controlled.state.recordingStops).toBe(1);

    await host.context.setOffline(true);
    await expect(host.page.getByText('Media offline')).toBeVisible();
    await host.context.setOffline(false);
    await expect(host.page.getByText('Reconnecting media')).toBeVisible();
    await host.page.evaluate(() => (window as unknown as { __IVEKIT_CONTROLLED_MEDIA__: { reconnect(): void } }).__IVEKIT_CONTROLLED_MEDIA__.reconnect());
    await expect(host.page.getByText('Reconnecting media')).toBeHidden();

    await host.page.evaluate(() => (window as unknown as { __IVEKIT_CONTROLLED_MEDIA__: { terminalDisconnect(): void } }).__IVEKIT_CONTROLLED_MEDIA__.terminalDisconnect());
    await expect(host.page.getByText('Reconnecting media')).toBeVisible();
    await expect(host.page.getByText('Screen sharing stopped during reconnect')).toBeVisible();
    await expect(host.page.getByTitle('Turn off microphone')).toBeVisible();
    await expect(host.page.getByTitle('Turn off camera')).toBeVisible();
    await expect.poll(() => controlled.state.joins.filter((value) => value === 'call-main:host-1').length).toBe(2);
    await expect.poll(() => controlled.state.connectionEvents.filter((value) => value.startsWith('call-main:host-1:'))).toEqual([
      'call-main:host-1:connected:1',
      'call-main:host-1:reconnecting:1',
      'call-main:host-1:reconnected:1',
      'call-main:host-1:disconnected:1',
      'call-main:host-1:rejoining:2',
      'call-main:host-1:rejoined:2'
    ]);
    await host.page.getByRole('button', { name: 'Resume sharing' }).click();
    await expect(host.page.locator('.screen-share-stage')).toBeVisible();

    await captureMediaDesktop(host.page, testInfo);
    await assertNoTokenPersistence(host.page);
    await host.page.getByTitle('Hang up').click();
    await expect(host.page.locator('.call-status')).toHaveText('Ended');
    await expect(participant.page.locator('.call-status')).toHaveText('Ended');
  } finally {
    await Promise.all([host.context.close(), participant.context.close()]);
  }
});

test('reject cancel timeout and participant revoke remain terminal', async ({ browser }) => {
  const rejected = await openIdentity(browser, 'participant-1', 'token-participant', 'call-reject');
  const cancelled = await openIdentity(browser, 'host-1', 'token-host', 'call-cancel');
  const timedOut = await openIdentity(browser, 'participant-1', 'token-participant', 'call-timeout');
  const host = await openIdentity(browser, 'host-1', 'token-host', 'call-revoke');
  const removed = await openIdentity(browser, 'participant-1', 'token-participant', 'call-revoke');
  try {
    await rejected.page.getByRole('button', { name: 'Reject' }).click();
    await expect(rejected.page.locator('.call-status')).toHaveText('Rejected');
    await cancelled.page.getByRole('button', { name: 'Cancel' }).click();
    await expect(cancelled.page.locator('.call-status')).toHaveText('Cancelled');
    controlled.expire('call-timeout');
    await expect(timedOut.page.locator('.call-status')).toHaveText('Timed out');

    await expect(host.page.locator('.call-status')).toHaveText('Active');
    await expect(removed.page.locator('.call-status')).toHaveText('Active');
    host.page.once('dialog', (dialog) => dialog.accept());
    await host.page.getByTitle('Remove LED Customer').click();
    await expect.poll(() => controlled.state.moderation).toContain('call-revoke:remove:participant-1');
    await expect(removed.page.getByRole('alert')).toContainText('media call not found');
    await expect(removed.page.getByTitle('Hang up')).toBeDisabled();
  } finally {
    await Promise.all([rejected, cancelled, timedOut, host, removed].map((item) => item.context.close()));
  }
});

test('mobile media layout keeps the stage rail and primary controls visible', async ({ browser }, testInfo) => {
  const mobile = await openIdentity(browser, 'participant-1', 'token-participant', 'call-mobile', { width: 390, height: 844 });
  try {
    await expect(mobile.page.locator('.call-status')).toHaveText('Active');
    await mobile.page.getByTitle('Share screen').click();
    await expect(mobile.page.locator('.screen-share-layout')).toBeVisible();
    const layout = await mobile.page.evaluate(() => {
      const rect = (selector: string) => {
        const value = document.querySelector(selector)?.getBoundingClientRect();
        return value ? { left: value.left, right: value.right, top: value.top, bottom: value.bottom, width: value.width, height: value.height } : null;
      };
      return {
        width: innerWidth,
        height: innerHeight,
        scrollWidth: document.documentElement.scrollWidth,
        stage: rect('.screen-share-stage'),
        rail: rect('.screen-share-rail'),
        toolbar: rect('.media-toolbar'),
        hangup: rect('button[title="Hang up"]')
      };
    });
    expect(layout.scrollWidth).toBe(layout.width);
    expect(layout.stage?.width).toBeGreaterThan(250);
    expect(layout.stage?.height).toBeGreaterThan(200);
    expect(layout.rail?.bottom).toBeLessThanOrEqual(layout.toolbar?.top || 0);
    expect(layout.hangup?.bottom).toBeLessThanOrEqual(layout.height);
    const path = testInfo.outputPath('ivekit-media-mobile.png');
    mkdirSync(testInfo.outputDir, { recursive: true });
    await mobile.page.screenshot({ path, fullPage: true });
    await testInfo.attach('ivekit-media-mobile', { path, contentType: 'image/png' });
  } finally {
    await mobile.context.close();
  }
});

async function openIdentity(
  browser: Browser,
  identity: string,
  token: string,
  callId: string,
  viewport = { width: 1440, height: 900 }
): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext({ viewport });
  await context.addInitScript(controlledBrowserInit);
  await context.addInitScript(({ accessToken, userIdentity }) => {
    window.__IVEKIT_DEV_ACCESS_TOKEN__ = accessToken;
    window.__IVEKIT_DEV_IDENTITY__ = userIdentity;
  }, { accessToken: token, userIdentity: identity });
  const page = await context.newPage();
  await page.route('**/converact-config.json', (route) => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify({ baseUrl: controlled.baseUrl, tenantId: 'tenant-e2e', websocketUrl: controlled.eventsUrl })
  }));
  await page.goto(`/?call_id=${callId}`);
  await expect(page.locator('.media-call-header')).toBeVisible();
  return { context, page };
}

function controlledBrowserInit() {
  const control = {
    rooms: [] as Array<{ emit(event: string, ...args: unknown[]): void; localParticipant: { setScreenShareEnabled(enabled: boolean): Promise<void> } }>,
    switchedDevices: [] as string[],
    captures: [] as unknown[],
    reconnect() {
      for (const room of this.rooms) {
        room.emit('reconnecting');
        window.setTimeout(() => room.emit('reconnected'), 20);
      }
    },
    terminalDisconnect() {
      this.rooms.at(-1)?.emit('disconnected', 9);
    }
  };
  (window as unknown as { __IVEKIT_CONTROLLED_MEDIA__: typeof control }).__IVEKIT_CONTROLLED_MEDIA__ = control;

  const mediaDeviceListeners = new Set<() => void>();
  const fakeMediaDevices = {
    async getUserMedia(constraints: unknown) {
      control.captures.push(constraints);
      return new MediaStream();
    },
    async enumerateDevices() {
      return [
        { kind: 'audioinput', deviceId: 'microphone-1', label: 'Desk microphone', groupId: 'group-1', toJSON() { return this; } },
        { kind: 'audioinput', deviceId: 'microphone-2', label: 'Headset microphone', groupId: 'group-2', toJSON() { return this; } },
        { kind: 'videoinput', deviceId: 'camera-1', label: 'Desk camera', groupId: 'group-1', toJSON() { return this; } },
        { kind: 'videoinput', deviceId: 'camera-2', label: 'Document camera', groupId: 'group-2', toJSON() { return this; } },
        { kind: 'audiooutput', deviceId: 'speaker-1', label: 'Desk speaker', groupId: 'group-1', toJSON() { return this; } },
        { kind: 'audiooutput', deviceId: 'speaker-2', label: 'Headset speaker', groupId: 'group-2', toJSON() { return this; } }
      ];
    },
    addEventListener(event: string, listener: () => void) { if (event === 'devicechange') mediaDeviceListeners.add(listener); },
    removeEventListener(event: string, listener: () => void) { if (event === 'devicechange') mediaDeviceListeners.delete(listener); }
  };
  Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: fakeMediaDevices });
  Object.defineProperty(HTMLMediaElement.prototype, 'setSinkId', {
    configurable: true,
    value: async function setSinkId(deviceId: string) { (this as HTMLMediaElement & { sinkId?: string }).sinkId = deviceId; }
  });

  (window as unknown as { __IVEKIT_DEV_LIVEKIT_ROOM_FACTORY__: () => unknown }).__IVEKIT_DEV_LIVEKIT_ROOM_FACTORY__ = () => {
    const listeners = new Map<string, Set<(...args: unknown[]) => void>>();
    let identity = '';
    const emit = (event: string, ...args: unknown[]) => {
      for (const listener of listeners.get(event) || []) listener(...args);
    };
    const participant = (value: string) => ({ identity: value, name: value === 'host-1' ? 'LED Host' : 'LED Customer' });
    const track = (owner: string, source: string) => ({
      kind: source === 'microphone' || source === 'screen_share_audio' ? 'audio' : 'video',
      attach(element: HTMLMediaElement) {
        element.dataset.controlledTrack = `${owner}:${source}`;
        element.style.backgroundColor = source === 'screen_share' ? 'rgb(42, 91, 66)' : 'rgb(49, 73, 91)';
        if (element instanceof HTMLVideoElement) {
          const label = encodeURIComponent(`${owner} ${source}`);
          element.poster = `data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='640' height='360'%3E%3Crect width='100%25' height='100%25' fill='%232a5b42'/%3E%3Ctext x='50%25' y='50%25' fill='white' text-anchor='middle'%3E${label}%3C/text%3E%3C/svg%3E`;
        }
        return element;
      },
      detach(element?: HTMLMediaElement) { if (element) delete element.dataset.controlledTrack; }
    });
    const publication = (owner: string, source: string) => ({ trackSid: `${owner}-${source}`, source, isMuted: false });
    const localParticipant = {
      async setMicrophoneEnabled(enabled: boolean) { emit(enabled ? 'localTrackPublished' : 'localTrackUnpublished', publication(identity, 'microphone')); },
      async setCameraEnabled(enabled: boolean) { emit(enabled ? 'localTrackPublished' : 'localTrackUnpublished', publication(identity, 'camera')); },
      async setScreenShareEnabled(enabled: boolean, options?: { audio?: boolean }) {
        emit(enabled ? 'localTrackPublished' : 'localTrackUnpublished', publication(identity, 'screen_share'));
        if (enabled) {
          emit('trackSubscribed', track(identity, 'screen_share'), publication(identity, 'screen_share'), participant(identity));
          if (options?.audio) emit('trackSubscribed', track(identity, 'screen_share_audio'), publication(identity, 'screen_share_audio'), participant(identity));
        } else {
          emit('trackUnsubscribed', null, publication(identity, 'screen_share'), participant(identity));
          emit('trackUnsubscribed', null, publication(identity, 'screen_share_audio'), participant(identity));
        }
      }
    };
    const room = {
      localParticipant,
      canPlaybackAudio: true,
      on(event: string, listener: (...args: unknown[]) => void) {
        const values = listeners.get(event) || new Set();
        values.add(listener);
        listeners.set(event, values);
        return this;
      },
      off(event: string, listener: (...args: unknown[]) => void) { listeners.get(event)?.delete(listener); return this; },
      emit,
      async connect(_url: string, token: string) {
        identity = token.split(':')[1] || '';
        const other = identity === 'host-1' ? 'participant-1' : 'host-1';
        emit('participantConnected', participant(other));
        emit('trackSubscribed', track(other, 'camera'), publication(other, 'camera'), participant(other));
        emit('trackSubscribed', track(other, 'microphone'), publication(other, 'microphone'), participant(other));
        emit('activeSpeakersChanged', [participant(other)]);
        emit('connectionQualityChanged', 'excellent', participant(other));
      },
      async disconnect() { return; },
      async switchActiveDevice(kind: MediaDeviceKind, deviceId: string) {
        control.switchedDevices.push(`${kind}:${deviceId}`);
        return true;
      },
      async startAudio() { this.canPlaybackAudio = true; emit('audioPlaybackChanged'); }
    };
    control.rooms.push(room);
    return room;
  };
}

async function rect(page: Page, selector: string) {
  return page.locator(selector).evaluate((element) => {
    const value = element.getBoundingClientRect();
    return { left: value.left, right: value.right, top: value.top, bottom: value.bottom, width: value.width, height: value.height };
  });
}

async function controlledBrowserState(page: Page, key: 'switchedDevices') {
  return page.evaluate((field) => {
    const state = (window as unknown as { __IVEKIT_CONTROLLED_MEDIA__: Record<string, unknown> }).__IVEKIT_CONTROLLED_MEDIA__;
    return state[field];
  }, key);
}

async function assertNoTokenPersistence(page: Page) {
  const persistence = await page.evaluate(async () => ({
    local: Object.values(localStorage),
    session: Object.values(sessionStorage),
    databases: 'databases' in indexedDB ? (await indexedDB.databases()).map((item) => item.name) : []
  }));
  expect(JSON.stringify(persistence)).not.toContain('token-host');
  expect(persistence.local).toEqual([]);
  expect(persistence.session).toEqual([]);
  expect(persistence.databases).toEqual([]);
}

async function captureMediaDesktop(page: Page, testInfo: TestInfo) {
  const layout = await page.evaluate(() => ({
    width: innerWidth,
    height: innerHeight,
    scrollWidth: document.documentElement.scrollWidth,
    stageText: (document.querySelector('.media-workspace-pane')?.textContent || '').trim().length,
    toolbarBottom: document.querySelector('.media-toolbar')?.getBoundingClientRect().bottom || 0,
    tileCount: document.querySelectorAll('.media-tile').length
  }));
  expect(layout.scrollWidth).toBe(layout.width);
  expect(layout.stageText).toBeGreaterThan(40);
  expect(layout.toolbarBottom).toBeLessThanOrEqual(layout.height);
  expect(layout.tileCount).toBeGreaterThanOrEqual(2);
  const path = testInfo.outputPath('ivekit-media-desktop.png');
  mkdirSync(testInfo.outputDir, { recursive: true });
  await page.screenshot({ path, fullPage: true });
  await testInfo.attach('ivekit-media-desktop', { path, contentType: 'image/png' });
}
