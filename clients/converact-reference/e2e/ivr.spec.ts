import { mkdirSync } from 'node:fs';

import { expect, test, type Browser, type BrowserContext, type Page, type TestInfo } from '@playwright/test';

test('desktop IVR Designer lazy-loads and completes the draft-to-simulation workflow', async ({ browser }, testInfo) => {
  const designer = await openDesigner(browser, { width: 1440, height: 900 }, false);
  try {
    expect(await loadedDesignerResources(designer.page)).toEqual([]);
    await designer.page.evaluate(() => {
      history.pushState({}, '', '/?workspace=ivr&flow_id=flow-a');
      dispatchEvent(new PopStateEvent('popstate'));
    });

    await expect(designer.page.getByRole('region', { name: 'IVR Designer' })).toBeVisible();
    await expect(designer.page.getByLabel('Flow name')).toHaveValue('LED inbound support');
    await expect(designer.page.locator('.ivr-palette button')).toHaveCount(26);
    expect((await loadedDesignerResources(designer.page)).length).toBeGreaterThan(0);

    await designer.page.getByLabel('Flow name').fill('LED inbound support v2');
    await designer.page.getByRole('button', { name: 'Add Play audio' }).click();
    await expect(designer.page.getByRole('heading', { name: 'Play audio' })).toBeVisible();
    await expect(designer.page.locator('.ivr-node-card').filter({ hasText: 'Play audio' })).toBeInViewport();
    await designer.page.getByTitle('Save flow draft').click();
    await expect(designer.page.getByRole('status')).toHaveText('Draft r4');

    await designer.page.getByTitle('Validate current draft').click();
    await expect(designer.page.locator('.ivr-validation .passed')).toHaveText('Validation passed');
    await designer.page.getByTitle('Publish current draft').click();
    await expect(designer.page.getByRole('status')).toHaveText('Published v3');

    await designer.page.getByTitle('Run deterministic simulation').click();
    await expect(designer.page.getByText('completed', { exact: true })).toBeVisible();
    await expect(designer.page.locator('.ivr-simulation-result > div > span')).toContainText('hangup');

    expect(designer.requests).toEqual(expect.arrayContaining([
      'GET /api/ivekit/ivr/flows',
      'GET /api/ivekit/ivr/flows/flow-a',
      'PATCH /api/ivekit/ivr/flows/flow-a',
      'POST /api/ivekit/ivr/flows/flow-a/validate',
      'POST /api/ivekit/ivr/flows/flow-a/publish',
      'POST /api/ivekit/ivr/simulations'
    ]));
    const layout = await designer.page.evaluate(() => {
      const rect = (selector: string) => {
        const value = document.querySelector(selector)?.getBoundingClientRect();
        return value ? { left: value.left, right: value.right, top: value.top, bottom: value.bottom } : null;
      };
      return {
        width: innerWidth,
        height: innerHeight,
        scrollWidth: document.documentElement.scrollWidth,
        designer: rect('.ivr-designer'),
        library: rect('.ivr-library'),
        editor: rect('.ivr-editor'),
        inspector: rect('.ivr-inspector'),
        canvas: rect('.ivr-canvas')
      };
    });
    expect(layout.scrollWidth).toBe(layout.width);
    expect(layout.designer?.bottom).toBeLessThanOrEqual(layout.height);
    expect(layout.library?.right).toBeLessThanOrEqual(layout.editor?.left || 0);
    expect(layout.editor?.right).toBeLessThanOrEqual(layout.inspector?.left || 0);
    expect(layout.canvas?.bottom).toBeLessThanOrEqual(layout.designer?.bottom || layout.height);
    await capture(designer.page, testInfo, 'ivekit-ivr-designer-desktop.png');
  } finally {
    await designer.context.close();
  }
});

test('mobile IVR Designer keeps every workspace inside the viewport', async ({ browser }, testInfo) => {
  const designer = await openDesigner(browser, { width: 390, height: 844 }, true);
  try {
    await expect(designer.page.getByRole('region', { name: 'IVR Designer' })).toBeVisible();
    await expect(designer.page.locator('.ivr-palette button')).toHaveCount(26);
    await expect(designer.page.getByLabel('Flow name')).toHaveValue('LED inbound support');
    const layout = await designer.page.evaluate(() => {
      const read = (selector: string) => {
        const value = document.querySelector(selector)?.getBoundingClientRect();
        return value ? { left: value.left, right: value.right, top: value.top, bottom: value.bottom, width: value.width } : null;
      };
      return {
        width: innerWidth,
        scrollWidth: document.documentElement.scrollWidth,
        designer: read('.ivr-designer'),
        library: read('.ivr-library'),
        editor: read('.ivr-editor'),
        inspector: read('.ivr-inspector'),
        toolbar: read('.ivr-toolbar')
      };
    });
    expect(layout.scrollWidth).toBe(layout.width);
    for (const panel of [layout.designer, layout.library, layout.editor, layout.inspector, layout.toolbar]) {
      expect(panel?.left).toBeGreaterThanOrEqual(0);
      expect(panel?.right).toBeLessThanOrEqual(layout.width);
    }
    expect(layout.library?.bottom).toBeLessThanOrEqual(layout.editor?.top || 0);
    expect(layout.editor?.bottom).toBeLessThanOrEqual(layout.inspector?.top || 0);
    await capture(designer.page, testInfo, 'ivekit-ivr-designer-mobile.png');
  } finally {
    await designer.context.close();
  }
});

async function openDesigner(
  browser: Browser,
  viewport: { width: number; height: number },
  direct: boolean
): Promise<{ context: BrowserContext; page: Page; requests: string[] }> {
  const context = await browser.newContext({ viewport });
  await context.addInitScript(() => {
    window.__IVEKIT_DEV_ACCESS_TOKEN__ = 'ivr-token';
    window.__IVEKIT_DEV_IDENTITY__ = 'ivr-designer';
  });
  const page = await context.newPage();
  const requests: string[] = [];
  let currentFlow = flow();
  await page.route('**/converact-config.json', (route) => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify({ baseUrl: 'http://127.0.0.1:4179', tenantId: 'tenant-e2e' })
  }));
  await page.route('**/api/ivekit/events*', (route) => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify({ items: [], next_cursor: 'event-head', has_more: false, snapshot_required: false })
  }));
  await page.route('**/api/ivekit/chat/sessions*', (route) => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify({ items: [], next_cursor: null, has_more: false })
  }));
  await page.route('**/api/ivekit/ivr/**', async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    const key = `${request.method()} ${path}`;
    requests.push(key);
    let response: unknown;
    if (key === 'GET /api/ivekit/ivr/flows') response = { items: [currentFlow] };
    else if (key === 'GET /api/ivekit/ivr/flows/flow-a') response = currentFlow;
    else if (key === 'PATCH /api/ivekit/ivr/flows/flow-a') {
      const body = request.postDataJSON() as { name?: string; graph?: Record<string, unknown> };
      currentFlow = {
        ...currentFlow,
        name: body.name || currentFlow.name,
        draft_graph: body.graph || currentFlow.draft_graph,
        draft_revision: currentFlow.draft_revision + 1
      };
      response = currentFlow;
    } else if (key === 'POST /api/ivekit/ivr/flows/flow-a/validate') {
      response = {
        normalized_graph: currentFlow.draft_graph,
        graph_hash: 'a'.repeat(64), errors: [], warnings: [], dependencies: {}
      };
    } else if (key === 'POST /api/ivekit/ivr/flows/flow-a/publish') {
      currentFlow = { ...currentFlow, status: 'published', current_published_version: 3 };
      response = { flow: currentFlow, version: version(3), replayed: false };
    } else if (key === 'POST /api/ivekit/ivr/simulations') response = simulation();
    else return route.fulfill({ status: 404, body: JSON.stringify({ error: `unhandled ${key}` }) });
    return route.fulfill({ contentType: 'application/json', body: JSON.stringify(response) });
  });
  await page.goto(direct ? '/?workspace=ivr&flow_id=flow-a' : '/');
  if (!direct) await expect(page.getByTitle('Show IVR Designer')).toBeVisible();
  return { context, page, requests };
}

function graph() {
  return {
    version: 1, entryNodeId: 'start', variables: [],
    nodes: [
      { id: 'start', type: 'start', name: 'Start', position: { x: 40, y: 80 }, data: {} },
      { id: 'end', type: 'disconnect', name: 'End', position: { x: 340, y: 80 }, data: {} }
    ],
    edges: [{ id: 'edge-1', source: 'start', target: 'end', sourceHandle: 'out' }]
  };
}

function flow() {
  return {
    id: 'flow-a', tenant_id: 'tenant-e2e', name: 'LED inbound support', status: 'draft',
    draft_graph: graph(), draft_revision: 3, current_published_version: 2, metadata: {},
    created_by: 'ivr-designer', updated_by: 'ivr-designer',
    created_at: '2026-07-13T00:00:00.000Z', updated_at: '2026-07-13T01:00:00.000Z'
  };
}

function version(number: number) {
  return {
    id: `version-${number}`, tenant_id: 'tenant-e2e', flow_id: 'flow-a', version: number,
    graph: graph(), graph_hash: 'a'.repeat(64), release_kind: 'publish', source_version: null,
    published_by: 'ivr-designer', published_at: '2026-07-13T02:00:00.000Z'
  };
}

function simulation() {
  return {
    status: 'completed',
    session: {
      id: 'simulation-a', tenant_id: 'tenant-e2e', call_id: 'simulation', flow_id: 'flow-a',
      flow_version: 3, state: 'completed', current_node_id: 'end', context: {}, step_count: 2, revision: 2
    },
    action: null, steps: [{ node_id: 'start' }, { node_id: 'end' }],
    trace: [{ action: { kind: 'hangup' }, event_at: '2026-07-13T02:00:00.010Z' }],
    elapsed_ms: 10, remaining_script_entries: 0
  };
}

function loadedDesignerResources(page: Page): Promise<string[]> {
  return page.evaluate(() => performance.getEntriesByType('resource')
    .map((entry) => entry.name)
    .filter((url) => /ivr-designer|\/node_modules\/@xyflow/.test(url)));
}

async function capture(page: Page, testInfo: TestInfo, filename: string): Promise<void> {
  const path = testInfo.outputPath(filename);
  mkdirSync(testInfo.outputDir, { recursive: true });
  await page.screenshot({ path, fullPage: true });
  await testInfo.attach(filename.replace(/\.png$/, ''), { path, contentType: 'image/png' });
}
