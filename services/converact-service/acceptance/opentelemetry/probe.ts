import assert from 'node:assert/strict';

import { SpanStatusCode, trace } from '@opentelemetry/api';

const endpoint = argument('--endpoint');
const mode = argument('--mode') || 'strict';
if (mode !== 'strict' && mode !== 'fail-open') throw new Error('invalid mode');

const startedAt = Date.now();
Object.assign(process.env, {
  NODE_ENV: 'production',
  CONVERACT_OTEL_ENABLED: '1',
  CONVERACT_OTEL_SERVICE_NAME: 'converact-otel-acceptance',
  CONVERACT_OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: endpoint,
  CONVERACT_OTEL_TRACE_SAMPLE_RATIO: '1',
  CONVERACT_OTEL_MAX_QUEUE_SIZE: '128',
  CONVERACT_OTEL_MAX_EXPORT_BATCH_SIZE: '16',
  CONVERACT_OTEL_SCHEDULED_DELAY_MS: '100',
  CONVERACT_OTEL_EXPORT_TIMEOUT_MS: '1000'
});
const {
  initializeOpenTelemetry,
  shutdownOpenTelemetry
} = await import('../../../../src/telemetry.js');
await initializeOpenTelemetry(process.env, 'converact-otel-acceptance');

let canaryCompleted = false;
let spanRecording = false;
let spanSampled = false;
await trace.getTracer('ivekit.acceptance').startActiveSpan(
  'ivekit.acceptance.control-operation',
  async (span) => {
    spanRecording = span.isRecording();
    spanSampled = (span.spanContext().traceFlags & 1) === 1;
    await new Promise((resolve) => setTimeout(resolve, 25));
    canaryCompleted = true;
    span.setStatus({ code: SpanStatusCode.OK });
    span.end();
  }
);
assert.equal(canaryCompleted, true);

let exportSucceeded = true;
try {
  await shutdownOpenTelemetry();
} catch {
  exportSucceeded = false;
}
if (mode === 'strict') assert.equal(exportSucceeded, true);

process.stdout.write(`${JSON.stringify({
  mode,
  canary_completed: canaryCompleted,
  span_recording: spanRecording,
  span_sampled: spanSampled,
  export_succeeded: exportSucceeded,
  elapsed_ms: Date.now() - startedAt
})}\n`);

function argument(name: string): string {
  const index = process.argv.indexOf(name);
  return index === -1 ? '' : String(process.argv[index + 1] || '');
}
