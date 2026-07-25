import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const prepare = resolve('infra/capacity/rustpbx-baseline/prepare.py');
const images = {
  RUSTPBX_IMAGE: 'ivekit/rustpbx:0.4.11-ivekit.19-6c49ee76',
  KAMAILIO_IMAGE: 'ivekit/kamailio:6.0.7-capacity-ced1eeb0',
  POSTGRES_IMAGE: `postgres@sha256:${'a'.repeat(64)}`,
  PYTHON_IMAGE: `python@sha256:${'b'.repeat(64)}`,
  CAPACITY_TOOLS_IMAGE: 'ivekit/capacity-tools:0.1.0-rustpbx-router-v1'
};

test('RustPBX media baseline can force an anchored RTP path', () => {
  const output = mkdtempSync(join(tmpdir(), 'ivekit-rustpbx-media-mode-'));
  try {
    const result = spawnSync('python3', [prepare, output], {
      encoding: 'utf8',
      env: {
        ...process.env,
        ...images,
        RUSTPBX_MEDIA_PROXY_MODE: 'all',
        RUSTPBX_RTP_START_PORT: '22000',
        RUSTPBX_RTP_END_PORT: '42000',
        RUSTRTC_UDP_RECEIVE_BUFFER_BYTES: '1048576',
        RUSTRTC_UDP_SEND_BUFFER_BYTES: '524288'
      }
    });

    assert.equal(result.status, 0, result.stderr);
    assert.match(
      readFileSync(join(output, 'rustpbx.toml'), 'utf8'),
      /^media_proxy = "all"$/m
    );
    assert.match(
      readFileSync(join(output, 'rustpbx.toml'), 'utf8'),
      /^rtp_start_port = 22000$/m
    );
    assert.match(
      readFileSync(join(output, 'rustpbx.toml'), 'utf8'),
      /^rtp_end_port = 42000$/m
    );
    assert.match(
      readFileSync(join(output, '.env'), 'utf8'),
      /^RUSTPBX_MEDIA_PROXY_MODE=all$/m
    );
    assert.match(
      readFileSync(join(output, '.env'), 'utf8'),
      /^RUSTPBX_RTP_START_PORT=22000$/m
    );
    assert.match(
      readFileSync(join(output, '.env'), 'utf8'),
      /^RUSTPBX_RTP_END_PORT=42000$/m
    );
    assert.match(
      readFileSync(join(output, '.env'), 'utf8'),
      /^RUSTRTC_UDP_RECEIVE_BUFFER_BYTES=1048576$/m
    );
    assert.match(
      readFileSync(join(output, '.env'), 'utf8'),
      /^RUSTRTC_UDP_SEND_BUFFER_BYTES=524288$/m
    );
  } finally {
    rmSync(output, { recursive: true, force: true });
  }
});

test('RustPBX media baseline rejects unsafe UDP socket buffers', () => {
  const output = mkdtempSync(join(tmpdir(), 'ivekit-rustpbx-media-buffer-'));
  try {
    const result = spawnSync('python3', [prepare, output], {
      encoding: 'utf8',
      env: {
        ...process.env,
        ...images,
        RUSTRTC_UDP_RECEIVE_BUFFER_BYTES: '32768'
      }
    });

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /RUSTRTC_UDP_RECEIVE_BUFFER_BYTES/);
  } finally {
    rmSync(output, { recursive: true, force: true });
  }
});

test('RustPBX media baseline rejects unknown media proxy modes', () => {
  const output = mkdtempSync(join(tmpdir(), 'ivekit-rustpbx-media-mode-'));
  try {
    const result = spawnSync('python3', [prepare, output], {
      encoding: 'utf8',
      env: {
        ...process.env,
        ...images,
        RUSTPBX_MEDIA_PROXY_MODE: 'forced'
      }
    });

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /RUSTPBX_MEDIA_PROXY_MODE/);
  } finally {
    rmSync(output, { recursive: true, force: true });
  }
});

test('RustPBX media baseline rejects unsafe RTP port ranges', () => {
  for (const range of [
    { start: '22001', end: '42000' },
    { start: '22000', end: '21998' },
    { start: '22000', end: '42001' }
  ]) {
    const output = mkdtempSync(join(tmpdir(), 'ivekit-rustpbx-media-range-'));
    try {
      const result = spawnSync('python3', [prepare, output], {
        encoding: 'utf8',
        env: {
          ...process.env,
          ...images,
          RUSTPBX_RTP_START_PORT: range.start,
          RUSTPBX_RTP_END_PORT: range.end
        }
      });

      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /RUSTPBX_RTP_(?:START|END)_PORT|RTP port range/);
    } finally {
      rmSync(output, { recursive: true, force: true });
    }
  }
});
