import { fileTypeFromBuffer } from 'file-type';

const DEFAULT_PROBE_BYTES = 8_192;
const MAX_PROBE_BYTES = 4 * 1024 * 1024;

export interface SecureFileMimeResult {
  mime: string;
  extension: string;
  detected: boolean;
  mime_conflict: boolean;
  probe_bytes?: number;
}

export async function detectSecureFileMime(
  contentInput: Buffer | Uint8Array,
  options: { declaredMime?: string; maxProbeBytes?: number } = {}
): Promise<SecureFileMimeResult> {
  const content = Buffer.isBuffer(contentInput) ? contentInput : Buffer.from(contentInput);
  const maxProbeBytes = boundedProbeBytes(options.maxProbeBytes ?? DEFAULT_PROBE_BYTES);
  const probe = content.subarray(0, Math.min(content.length, maxProbeBytes));
  let detected: Awaited<ReturnType<typeof fileTypeFromBuffer>>;
  try {
    detected = await fileTypeFromBuffer(probe);
  } catch {
    detected = undefined;
  }
  const mime = detected?.mime.toLowerCase() || 'application/octet-stream';
  const declared = normalizedDeclaredMime(options.declaredMime);
  return {
    mime,
    extension: detected?.ext.toLowerCase() || '',
    detected: Boolean(detected),
    mime_conflict: Boolean(declared && declared !== mime),
    ...(options.maxProbeBytes == null ? {} : { probe_bytes: probe.length })
  };
}

function boundedProbeBytes(value: number): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 4_100 || parsed > MAX_PROBE_BYTES) {
    throw Object.assign(new Error(`maxProbeBytes must be between 4100 and ${MAX_PROBE_BYTES}`), {
      status: 400,
      code: 'mime_probe_size_invalid'
    });
  }
  return parsed;
}

function normalizedDeclaredMime(value: unknown): string {
  const mime = String(value || '').trim().toLowerCase();
  return /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/.test(mime) ? mime : '';
}
