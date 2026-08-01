import dgram from 'node:dgram';
import { randomUUID } from 'node:crypto';
import {
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync
} from 'node:fs';
import { dirname, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';

const [outputInput, readyInput, faultWindowInput, durationInput] = process.argv.slice(2);
if (!outputInput || !readyInput || !faultWindowInput) fail('synthetic_media_arguments_invalid');
const durationMs = Number(durationInput || 30_000);
if (!Number.isSafeInteger(durationMs) || durationMs < 5_000 || durationMs > 300_000) {
  fail('synthetic_media_duration_invalid');
}

const output = resolve(outputInput);
const ready = resolve(readyInput);
const faultWindow = resolve(faultWindowInput);
const intervalMs = 20;
const receiver = dgram.createSocket('udp4');
const sender = dgram.createSocket('udp4');
const received = [];
const seen = new Set();
let duplicates = 0;
let sent = 0;
let interval;

receiver.on('message', (message) => {
  if (message.length !== 4) return;
  const sequence = message.readUInt32BE(0);
  if (seen.has(sequence)) duplicates += 1;
  else seen.add(sequence);
  received.push({ sequence, monotonic_ms: performance.now(), wall_ms: Date.now() });
  if (received.length === 1) writeJsonExclusive(ready, {
    status: 'ready', kind: 'synthetic_transport', process_pid: process.pid
  });
});

try {
  await bind(receiver);
  const address = receiver.address();
  if (typeof address === 'string') fail('synthetic_media_address_invalid');
  interval = setInterval(() => {
    const packet = Buffer.allocUnsafe(4);
    packet.writeUInt32BE(sent >>> 0, 0);
    sent += 1;
    sender.send(packet, address.port, '127.0.0.1');
  }, intervalMs);
  await delay(durationMs);
  clearInterval(interval);
  interval = undefined;
  await delay(150);

  const window = readJson(faultWindow);
  const faultStart = timestamp(window.started_at);
  const faultEnd = timestamp(window.completed_at);
  if (faultEnd <= faultStart) fail('synthetic_media_fault_window_invalid');
  const ordered = [...received].sort((left, right) => left.monotonic_ms - right.monotonic_ms);
  let maximumGapMs = 0;
  for (let index = 1; index < ordered.length; index += 1) {
    maximumGapMs = Math.max(
      maximumGapMs,
      ordered[index].monotonic_ms - ordered[index - 1].monotonic_ms
    );
  }
  const establishedBefore = ordered.some((packet) => packet.wall_ms < faultStart);
  const during = ordered.some((packet) => packet.wall_ms >= faultStart && packet.wall_ms <= faultEnd);
  const completedAfter = ordered.some((packet) => packet.wall_ms > faultEnd);
  const lost = Math.max(0, sent - seen.size);
  const report = {
    status: sent > 0 && lost === 0 && duplicates === 0 && maximumGapMs <= 250
      && establishedBefore && during && completedAfter ? 'passed' : 'failed',
    kind: 'synthetic_transport',
    sent_packets: sent,
    received_packets: seen.size,
    lost_packets: lost,
    duplicate_packets: duplicates,
    maximum_gap_ms: Number(maximumGapMs.toFixed(3)),
    established_before_fault: establishedBefore,
    continuous_during_fault: during && maximumGapMs <= 250,
    completed_after_recovery: completedAfter,
    interval_ms: intervalMs,
    duration_ms: durationMs,
    production_eligible: false,
    real_human_media: false
  };
  writeJson(output, report);
  if (report.status !== 'passed') process.exitCode = 1;
} catch (error) {
  process.stderr.write(`${JSON.stringify({
    status: 'failed',
    code: safeCode(error)
  })}\n`);
  process.exitCode = 1;
} finally {
  if (interval) clearInterval(interval);
  receiver.close();
  sender.close();
}

function bind(socket) {
  return new Promise((resolvePromise, reject) => {
    socket.once('error', reject);
    socket.bind({ address: '127.0.0.1', port: 0, exclusive: true }, () => {
      socket.off('error', reject);
      resolvePromise();
    });
  });
}

function delay(milliseconds) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));
}

function readJson(path) {
  const value = JSON.parse(readFileSync(resolve(path), 'utf8'));
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('synthetic_media_json_invalid');
  return value;
}

function timestamp(value) {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))
    || new Date(value).toISOString() !== value) fail('synthetic_media_timestamp_invalid');
  return Date.parse(value);
}

function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, {
      encoding: 'utf8', mode: 0o600, flag: 'wx'
    });
    renameSync(temporary, path);
  } catch (error) {
    try { unlinkSync(temporary); } catch { /* nothing to remove */ }
    throw error;
  }
}

function writeJsonExclusive(path, value) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, `${JSON.stringify(value)}\n`, {
    encoding: 'utf8', mode: 0o600, flag: 'wx'
  });
}

function safeCode(error) {
  return String(error?.code || error?.message || 'synthetic_media_failed')
    .replace(/[^A-Za-z0-9._-]/gu, '_').slice(0, 160);
}

function fail(code) {
  throw Object.assign(new Error(code), { code });
}
