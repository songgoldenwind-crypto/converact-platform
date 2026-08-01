import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer as createHttpServer } from 'node:http';
import { dirname, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { createDatabase } from '../src/db.js';
import { AIWorkerClient } from '../src/agent-runtime/ai/ai-worker-client.js';
import { createHarness } from '../src/agent-runtime/index.js';
import { ProviderGatewayClient } from '../src/agent-runtime/integrations/provider-gateway-client.js';
import { VoiceMediaClient } from '../src/agent-runtime/voice/voice-media-client.js';
import { createTenant } from '../src/services.js';
import { listenOnRandomPort } from './test-helpers.js';

test('Go provider gateway boundary proxies geo provider execution', async () => {
  const db = createDatabase(':memory:');
  const tenant = createTenant(db, { name: 'Go Gateway Boundary 公司' });
  const harness = createHarness(db);
  const seenRequests = [];
  const gatewayServer = createHttpServer(async (req, res) => {
    const body = await readJsonBody(req);
    seenRequests.push({ url: req.url, body });
    if (req.url === '/execute') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        status: 'execute',
        status_code: 200,
        body: {
          places: [
            {
              id: 'go-place-1',
              name: 'Gateway Lead',
              type: 'call_center',
              city: 'Shenzhen',
              address: 'Nanshan',
              rating: 4.2,
              review_count: 18
            }
          ]
        }
      }));
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ status: 'health_check', status_code: 200, body: { status: 'ok' } }));
  });

  const gatewayUrl = await listen(gatewayServer);
  try {
    harness.integrationConfigStore.upsertConfig({
      tenant_id: tenant.id,
      integration_id: 'amap-place-search',
      status: 'configured',
      config: {
        base_url: 'http://provider-upstream.local',
        provider_gateway_url: gatewayUrl
      }
    });

    const result = await harness.providerRegistryStore.executeProviderOperation({
      tenant_id: tenant.id,
      integration_id: 'amap-place-search',
      operation: 'place.search',
      payload: {
        query: 'call center shenzhen',
        city: 'Shenzhen',
        business_type: 'call_center'
      }
    });

    assert.equal(result.language_boundary, 'go_provider_gateway');
    assert.equal(result.places[0].external_place_id, 'go-place-1');
    assert.equal(seenRequests.length, 1);
    assert.equal(seenRequests[0].body.integration_id, 'amap-place-search');
    assert.equal(seenRequests[0].body.operation, 'place.search');
    assert.equal(seenRequests[0].body.request.url, 'http://provider-upstream.local/api/places/search');
    assert.equal(JSON.parse(seenRequests[0].body.request.body).city, 'Shenzhen');
  } finally {
    await closeServer(gatewayServer);
  }
});

test('Python AI worker boundary normalizes geo insight and outreach payloads through tenant config', async () => {
  const db = createDatabase(':memory:');
  const tenant = createTenant(db, { name: 'Python Worker Boundary 公司' });
  const seenRequests = [];
  const workerServer = createHttpServer(async (req, res) => {
    const body = await readJsonBody(req);
    seenRequests.push({ url: req.url, body });
    res.writeHead(200, { 'content-type': 'application/json' });
    if (req.url === '/geo/pain-signals/extract') {
      res.end(JSON.stringify({
        summary: 'PY worker insight summary',
        pain_signals: [
          {
            signal: '客户在评论里反复提到回访不及时',
            evidence_review_id: body.reviews?.[0]?.id || 'review-1',
            evidence: 'worker-evidence',
            urgency: 'high'
          }
        ]
      }));
      return;
    }
    if (req.url === '/geo/outreach/personalize') {
      res.end(JSON.stringify({
        subject: 'PY worker subject',
        message: 'PY worker personalized message',
        personalization_points: ['Shenzhen', 'call_center', 'AI回访方案']
      }));
      return;
    }
    if (req.url === '/signals/public-source/analyze') {
      res.end(JSON.stringify({
        status: 'ready',
        worker_language: 'python',
        counts: { raw: 1, deduped: 1, scored: 1, filtered: 1, enriched: 1 },
        signal_guidance: {
          summary: 'PY worker signal summary',
          preferred_sources: [{ source_kind: 'social', source_label: '社媒/问答' }]
        }
      }));
      return;
    }
    if (req.url === '/page/crawl-markdown') {
      res.end(JSON.stringify({
        status: 'ready',
        worker_language: 'python',
        source_url: body.url,
        markdown: '# Python worker page\n\n页面里提到今天回拨和 CRM 报价。',
        clean_text: '页面里提到今天回拨和 CRM 报价。',
        extraction_mode: 'crawl4ai_markdown',
        metadata: {
          final_url: body.url,
          page_title: 'Python worker page'
        },
        extracted_links: [],
        extracted_images: []
      }));
      return;
    }
    if (req.url === '/page/evidence-extract') {
      res.end(JSON.stringify({
        status: 'ready',
        worker_language: 'python',
        source_url: body.url,
        page_title: 'Python worker page',
        page_headline: 'Python worker headline',
        cta_blocks: [
          {
            block_id: 'cta_block_1',
            label: '立即咨询',
            action_hint: 'push_to_consult',
            evidence: '立即咨询'
          }
        ],
        faq_blocks: [],
        proof_points: [],
        contact_blocks: [],
        offer_summary: '这页主打今天回拨。',
        evidence_summary: '已抽出 CTA。'
      }));
      return;
    }
    if (req.url === '/page/visual-fallback') {
      res.end(JSON.stringify({
        status: 'ready',
        worker_language: 'python',
        source_url: body.url,
        page_title: 'Python worker page',
        screenshot_ref: {
          ref_id: 'visual-shot-1',
          capture_status: 'captured',
          worker_language: 'python'
        },
        visual_chunks: [
          {
            chunk_id: 'visual_chunk_1',
            chunk_index: 0,
            text: '页面可见今天回拨 CTA',
            region_kind: 'hero_text',
            confidence: 0.92
          }
        ],
        recognized_text: '页面可见今天回拨 CTA',
        layout_regions: [
          {
            region_id: 'visual_region_1',
            region_kind: 'hero_text',
            text: '页面可见今天回拨 CTA',
            confidence: 0.92
          }
        ],
        fallback_reason: body.fallback_reason || 'markdown_extraction_failed',
        confidence_summary: {
          overall_confidence: 0.92,
          region_count: 1,
          low_confidence_regions: 0,
          engine: 'pytesseract_ocr'
        }
      }));
      return;
    }
    res.end(JSON.stringify({ status: 'ok' }));
  });

  const workerUrl = await listen(workerServer);
  const harness = createHarness(db);
  try {
    harness.integrationConfigStore.upsertConfig({
      tenant_id: tenant.id,
      integration_id: 'opc-ai-worker',
      status: 'configured',
      config: {
        base_url: workerUrl
      }
    });

    const session = await harness.toolExecutor.execute(toolContext(tenant.id, 'geo_agent', 'session'), 'geo.session_upsert', {
      tenant_id: tenant.id,
      name: 'Python worker geo session',
      business_type: 'call_center',
      city: 'Shenzhen',
      search_query: 'call center shenzhen'
    });
    const place = await harness.toolExecutor.execute(toolContext(tenant.id, 'geo_agent', 'place'), 'geo.place_upsert', {
      tenant_id: tenant.id,
      session_id: session.output.session_id,
      name: 'Python Boundary Lead',
      business_type: 'call_center',
      city: 'Shenzhen'
    });
    await harness.toolExecutor.execute(toolContext(tenant.id, 'geo_agent', 'review-1'), 'geo.review_ingest', {
      tenant_id: tenant.id,
      place_id: place.output.id,
      author_name: 'Alice',
      rating: 2,
      content: '客户抱怨接通慢，下班后没人回访。'
    });

    const insight = await harness.toolExecutor.execute(
      toolContext(tenant.id, 'geo_agent', 'insight'),
      'geo.extract_place_pain_signals',
      {
        tenant_id: tenant.id,
        place_id: place.output.id
      }
    );
    const draft = await harness.toolExecutor.execute(
      toolContext(tenant.id, 'geo_agent', 'draft'),
      'geo.generate_outreach_draft',
      {
        tenant_id: tenant.id,
        place_id: place.output.id,
        insight_id: insight.output.insight.id,
        product_offer: 'AI回访方案',
        channel: 'email'
      }
    );
    const pipeline = await new AIWorkerClient({ baseUrl: workerUrl }).analyzePublicSourceSignals({
      tenant_id: tenant.id,
      candidates: [{ company_name: 'Python Boundary Lead', source_kind: 'social', source_evidence: '公开问答里在问报价' }]
    });
    const client = new AIWorkerClient({ baseUrl: workerUrl });
    const crawl = await client.extractCrawlMarkdown({
      tenant_id: tenant.id,
      url: 'https://example.com/pricing'
    });
    const pageEvidence = await client.extractPageEvidence({
      tenant_id: tenant.id,
      url: 'https://example.com/pricing',
      clean_text: '页面里提到今天回拨和 CRM 报价。',
      markdown: '# Python worker headline\n\n页面里提到今天回拨和 CRM 报价。'
    });
    const visualFallback = await client.extractVisualPageFallback({
      tenant_id: tenant.id,
      url: 'https://example.com/pricing',
      fallback_reason: 'markdown_extraction_failed'
    });
    const pipelineGuidance = (pipeline.signal_guidance || {}) as Record<string, any>;
    const preferredSources = Array.isArray(pipelineGuidance.preferred_sources) ? pipelineGuidance.preferred_sources : [];

    assert.equal(insight.output.insight.summary, 'PY worker insight summary');
    assert.equal(insight.output.insight.pain_signals[0].signal, '客户在评论里反复提到回访不及时');
    assert.equal(draft.output.draft.subject, 'PY worker subject');
    assert.equal(draft.output.draft.message, 'PY worker personalized message');
    assert.deepEqual(draft.output.draft.personalization_points, ['Shenzhen', 'call_center', 'AI回访方案']);
    assert.equal(pipeline.worker_language, 'python');
    assert.equal(preferredSources[0].source_kind, 'social');
    assert.equal(crawl.extraction_mode, 'crawl4ai_markdown');
    assert.equal(pageEvidence.page_headline, 'Python worker headline');
    assert.equal(visualFallback.fallback_reason, 'markdown_extraction_failed');
    assert.deepEqual(
      seenRequests.map((entry) => entry.url),
      [
        '/geo/pain-signals/extract',
        '/geo/outreach/personalize',
        '/signals/public-source/analyze',
        '/page/crawl-markdown',
        '/page/evidence-extract',
        '/page/visual-fallback'
      ]
    );
  } finally {
    await closeServer(workerServer);
  }
});

test('Python AI worker sidecar exposes page capture routes expected by the TypeScript client', async () => {
  const port = await reservePort();
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const worker = spawn('python3', ['services/ai-worker-py/server.py'], {
    cwd: repoRoot,
    env: {
      ...process.env,
      HOST: '127.0.0.1',
      PORT: String(port)
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let stdout = '';
  let stderr = '';
  worker.stdout.on('data', (chunk) => {
    stdout += String(chunk);
  });
  worker.stderr.on('data', (chunk) => {
    stderr += String(chunk);
  });

  try {
    const baseUrl = `http://127.0.0.1:${port}`;
    await waitForSidecarHealth(baseUrl, worker);
    const client = new AIWorkerClient({ baseUrl });

    const crawl = await client.extractCrawlMarkdown({
      tenant_id: 'tenant_test',
      url: 'https://example.com/pricing',
      page_goal: '抽出页面里的报价和回拨线索',
      industry: '企业服务',
      location: '杭州'
    });
    const pageEvidence = await client.extractPageEvidence({
      tenant_id: 'tenant_test',
      url: 'https://example.com/pricing',
      clean_text: '页面里提到今天回拨和 CRM 报价。',
      markdown: '# 页面\n\n页面里提到今天回拨和 CRM 报价。',
      page_goal: '抽出 CTA 与证据',
      industry: '企业服务',
      location: '杭州'
    });
    const visualFallback = await client.extractVisualPageFallback({
      tenant_id: 'tenant_test',
      url: 'https://example.com/pricing',
      fallback_reason: 'markdown_extraction_failed',
      page_title: 'Example pricing page',
      rendered_text: '',
      clean_text: '',
      markdown: '',
      page_goal: '补回可见文案',
      industry: '企业服务',
      location: '杭州'
    });

    assert.equal(crawl.status, 'ready');
    assert.equal(crawl.worker_language, 'python');
    assert.equal(crawl.extraction_mode, 'crawl4ai_markdown');
    assert.equal(pageEvidence.status, 'ready');
    assert.equal(pageEvidence.worker_language, 'python');
    assert.equal(pageEvidence.page_headline, '页面');
    assert.ok(Array.isArray(pageEvidence.cta_blocks));
    assert.equal(visualFallback.status, 'ready');
    assert.equal(visualFallback.worker_language, 'python');
    assert.equal(visualFallback.fallback_reason, 'markdown_extraction_failed');
    assert.ok(Array.isArray(visualFallback.visual_chunks));
  } finally {
    if (!worker.killed) worker.kill('SIGTERM');
    await waitForExit(worker);
    if (worker.exitCode && worker.exitCode !== 0) {
      throw new Error(`python worker exited with code ${worker.exitCode}\nstdout:\n${stdout}\nstderr:\n${stderr}`);
    }
  }
});

test('Rust voice media boundary issues WebRTC sessions and recording retention ops through sidecar', async () => {
  const db = createDatabase(':memory:');
  const tenant = createTenant(db, { name: 'Rust Media Boundary 公司' });
  const seenRequests = [];
  const mediaServer = createHttpServer(async (req, res) => {
    const body = await readJsonBody(req);
    seenRequests.push({ url: req.url, headers: req.headers, body });
    if (req.url === '/webrtc/session/create') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        token: 'rust-media-token',
        token_hash: 'rust-media-token-hash',
        endpoint_id: body.endpoint_id || 'browser',
        expires_at: '2030-01-01T00:00:00.000Z',
        ice_servers: [
          {
            urls: 'turn:media.local:3478',
            username: 'voice',
            credential: 'secret'
          }
        ],
        boundary: 'rust_media'
      }));
      return;
    }
    if (req.url === '/recordings/archive') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        status: 'archived',
        archived_recording_url: `${body.archive_url_base}/${body.provider_recording_id}`,
        boundary: 'rust_media'
      }));
      return;
    }
    if (req.url === '/recordings/purge') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        status: 'purged',
        purged_recording_url: body.archived_recording_url,
        boundary: 'rust_media'
      }));
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok' }));
  });

  const mediaUrl = await listen(mediaServer);
  const harness = createHarness(db, { voiceMedia: { baseUrl: mediaUrl } });
  try {
    const result = await harness.toolExecutor.execute(
      toolContext(tenant.id, 'voice_agent', 'webrtc'),
      'voice.webrtc_create_session',
      {
        tenant_id: tenant.id,
        endpoint_id: 'browser'
      }
    );

    assert.equal(result.output.boundary, 'rust_media');
    assert.equal(result.output.token, 'rust-media-token');
    assert.equal(result.output.session.token_hash, 'rust-media-token-hash');
    assert.equal(result.output.session.ice_servers[0].urls, 'turn:media.local:3478');

    const client = new VoiceMediaClient({ baseUrl: mediaUrl });
    const archived = await client.archiveRecording({
      runtimeConfig: {
        media_service_url: mediaUrl,
        media_api_token: 'voice-media-token'
      },
      tenant_id: tenant.id,
      recording_id: 'recording_1',
      provider_recording_id: 'provider-recording-1',
      archive_url_base: 's3://voice-archive/boundary'
    });
    const purged = await client.purgeRecording({
      runtimeConfig: {
        media_service_url: mediaUrl,
        media_api_token: 'voice-media-token'
      },
      tenant_id: tenant.id,
      recording_id: 'recording_1',
      archived_recording_url: 's3://voice-archive/boundary/provider-recording-1'
    });

    assert.equal(archived.status, 'archived');
    assert.equal(archived.archived_recording_url, 's3://voice-archive/boundary/provider-recording-1');
    assert.equal(purged.status, 'purged');
    assert.equal(purged.purged_recording_url, 's3://voice-archive/boundary/provider-recording-1');
    assert.equal(seenRequests[1].headers.authorization, 'Bearer voice-media-token');
    assert.equal(seenRequests[2].url, '/recordings/purge');
  } finally {
    await closeServer(mediaServer);
  }
});

test('sidecar clients surface non-json upstream errors without parser crashes', async () => {
  const errorServer = createHttpServer(async (req, res) => {
    await drainBody(req);
    res.writeHead(502, { 'content-type': 'text/plain' });
    res.end('temporary sidecar outage');
  });
  const baseUrl = await listen(errorServer);

  try {
    await assert.rejects(
      () => new AIWorkerClient({ baseUrl }).extractPainSignals({ tenant_id: 'tenant_test' }),
      /temporary sidecar outage/
    );
    await assert.rejects(
      () => new VoiceMediaClient({ baseUrl }).issueWebrtcSession({ tenant_id: 'tenant_test' }),
      /temporary sidecar outage/
    );
    await assert.rejects(
      () => new ProviderGatewayClient({ gatewayUrl: baseUrl }).execute({
        integrationId: 'amap-place-search',
        operation: 'place.search',
        request: {
          url: 'http://provider.local/api/places/search',
          method: 'POST',
          headers: {},
          body: '{}'
        }
      }),
      /temporary sidecar outage/
    );
  } finally {
    await closeServer(errorServer);
  }
});

test('ops playbook reports polyglot sidecar health through the runtime', async () => {
  const db = createDatabase(':memory:');
  const tenant = createTenant(db, { name: 'Ops Sidecar Health 公司' });
  const healthServer = createHttpServer(async (req, res) => {
    await drainBody(req);
    if (req.url === '/health') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', url: req.url }));
      return;
    }
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'not_found' }));
  });
  const sidecarUrl = await listen(healthServer);
  const harness = createHarness(db, {
    providerGatewayClient: { gatewayUrl: sidecarUrl }
  });

  try {
    harness.integrationConfigStore.upsertConfig({
      tenant_id: tenant.id,
      integration_id: 'opc-ai-worker',
      status: 'configured',
      config: { base_url: sidecarUrl }
    });
    harness.integrationConfigStore.upsertConfig({
      tenant_id: tenant.id,
      integration_id: 'opc-native-webrtc',
      status: 'configured',
      config: { media_service_url: sidecarUrl }
    });

    const result = await harness.runtime.runPlaybook({
      tenant_id: tenant.id,
      workspace_id: 'default',
      user_id: 'ops_user',
      playbook_id: 'ops_agent.polyglot_sidecar_health.v1',
      goal: '检查多语言 sidecar 健康状态'
    });

    assert.equal(result.agent_run.status, 'completed');
    assert.equal(result.step_outputs.check_sidecars.status, 'healthy');
    assert.deepEqual(
      result.step_outputs.check_sidecars.sidecars.map((sidecar) => sidecar.language).sort(),
      ['go', 'python', 'rust']
    );
    assert.equal(
      result.step_outputs.check_sidecars.sidecars.every((sidecar) => sidecar.status === 'healthy'),
      true
    );
    assert.ok(result.artifacts.some((artifact) => artifact.type === 'ops_sidecar_health_report'));
  } finally {
    await closeServer(healthServer);
  }
});

function toolContext(tenantId, agentId, stepId) {
  return {
    tenantId,
    workspaceId: 'default',
    userId: 'user_test',
    agentId,
    workflowRunId: null,
    agentRunId: null,
    playbookId: 'manual',
    stepId
  };
}

async function readJsonBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {};
}

async function drainBody(req) {
  for await (const _chunk of req) {
    // Drain the request body so Node completes the response cleanly.
  }
}

async function listen(server): Promise<string> {
  const port = await listenOnRandomPort(server);
  return `http://127.0.0.1:${port}`;
}

function closeServer(server) {
  return new Promise((resolve) => server.close(resolve));
}

async function reservePort(): Promise<number> {
  const server = createHttpServer((_req, res) => res.end('ok'));
  const port = await listenOnRandomPort(server);
  await closeServer(server);
  return port;
}

async function waitForSidecarHealth(baseUrl: string, worker, timeoutMs = 5000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (worker.exitCode !== null) {
      throw new Error(`python worker exited early with code ${worker.exitCode}`);
    }
    try {
      const response = await fetch(`${baseUrl}/health`);
      if (response.ok) return;
    } catch {
      // Wait for the process to start listening.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`python worker did not become healthy within ${timeoutMs}ms`);
}

function waitForExit(worker): Promise<void> {
  return new Promise((resolve) => {
    if (worker.exitCode !== null) {
      resolve();
      return;
    }
    worker.once('exit', () => resolve());
  });
}
