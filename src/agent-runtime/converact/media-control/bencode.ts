const INTEGER_MIN = -(1n << 63n);
const INTEGER_MAX = (1n << 63n) - 1n;

const DEFAULT_LIMITS = {
  maxDepth: 32,
  maxNodes: 10_000,
  maxBytes: 1024 * 1024,
  maxStringBytes: 1024 * 1024
};

export interface BencodeLimits {
  maxDepth?: number;
  maxNodes?: number;
  maxBytes?: number;
  maxStringBytes?: number;
}

export type BencodeDictionary = {
  [key: string]: BencodeValue;
};

export type BencodeValue =
  | Buffer
  | Uint8Array
  | string
  | number
  | bigint
  | BencodeValue[]
  | BencodeDictionary;

export class BencodeError extends Error {
  readonly incomplete: boolean;

  constructor(
    readonly code: string,
    options: { incomplete?: boolean } = {}
  ) {
    super(code);
    this.name = 'BencodeError';
    this.incomplete = options.incomplete === true;
  }
}

export function encodeBencode(
  value: BencodeValue,
  options: BencodeLimits = {}
): Buffer {
  const limits = checkedLimits(options);
  const chunks: Buffer[] = [];
  const active = new Set<object>();
  let bytes = 0;
  let nodes = 0;

  const append = (chunk: Buffer): void => {
    bytes += chunk.length;
    if (bytes > limits.maxBytes) throw failure('bencode_bytes_exceeded');
    chunks.push(chunk);
  };

  const encode = (candidate: BencodeValue, depth: number): void => {
    if (depth > limits.maxDepth) throw failure('bencode_depth_exceeded');
    nodes += 1;
    if (nodes > limits.maxNodes) throw failure('bencode_nodes_exceeded');

    if (typeof candidate === 'string' || Buffer.isBuffer(candidate) ||
        candidate instanceof Uint8Array) {
      const encoded = typeof candidate === 'string'
        ? Buffer.from(candidate, 'utf8')
        : Buffer.from(candidate);
      if (encoded.length > limits.maxStringBytes) {
        throw failure('bencode_string_exceeded');
      }
      append(Buffer.from(`${encoded.length}:`, 'ascii'));
      append(encoded);
      return;
    }

    if (typeof candidate === 'number' || typeof candidate === 'bigint') {
      const integer = checkedInteger(candidate);
      append(Buffer.from(`i${integer}e`, 'ascii'));
      return;
    }

    if (Array.isArray(candidate)) {
      enterContainer(candidate, active);
      append(Buffer.from('l'));
      try {
        for (const item of candidate) encode(item, depth + 1);
      } finally {
        active.delete(candidate);
      }
      append(Buffer.from('e'));
      return;
    }

    if (isDictionary(candidate)) {
      enterContainer(candidate, active);
      append(Buffer.from('d'));
      try {
        const entries = Object.keys(candidate).map((key) => ({
          key,
          encoded: encodedDictionaryKey(key)
        }));
        entries.sort((left, right) => Buffer.compare(left.encoded, right.encoded));
        let previousKey: Buffer | undefined;
        for (const entry of entries) {
          if (previousKey && Buffer.compare(previousKey, entry.encoded) === 0) {
            throw failure('bencode_duplicate_key');
          }
          previousKey = entry.encoded;
          if (entry.encoded.length > limits.maxStringBytes) {
            throw failure('bencode_string_exceeded');
          }
          append(Buffer.from(`${entry.encoded.length}:`, 'ascii'));
          append(entry.encoded);
          encode(candidate[entry.key], depth + 1);
        }
      } finally {
        active.delete(candidate);
      }
      append(Buffer.from('e'));
      return;
    }

    throw failure('bencode_value_invalid');
  };

  encode(value, 0);
  return Buffer.concat(chunks, bytes);
}

export function decodeBencode(
  input: Uint8Array,
  options: BencodeLimits = {}
): BencodeValue {
  const buffer = Buffer.from(input);
  const limits = checkedLimits(options);
  if (buffer.length > limits.maxBytes) {
    throw failure('bencode_bytes_exceeded');
  }
  const decoded = decodePrefix(buffer, limits);
  if (decoded.bytesRead !== buffer.length) {
    throw failure('bencode_trailing_bytes');
  }
  return decoded.value;
}

export function decodeBencodePrefix(
  input: Uint8Array,
  options: BencodeLimits = {}
): { value: BencodeValue; bytesRead: number } {
  return decodePrefix(Buffer.from(input), checkedLimits(options));
}

function decodePrefix(
  input: Buffer,
  limits: Required<BencodeLimits>
): { value: BencodeValue; bytesRead: number } {
  let offset = 0;
  let nodes = 0;

  const requireByte = (): number => {
    if (offset >= input.length) throw incomplete();
    if (offset >= limits.maxBytes) throw failure('bencode_bytes_exceeded');
    return input[offset];
  };

  const parse = (depth: number): BencodeValue => {
    if (depth > limits.maxDepth) throw failure('bencode_depth_exceeded');
    nodes += 1;
    if (nodes > limits.maxNodes) throw failure('bencode_nodes_exceeded');

    const token = requireByte();
    if (token >= 48 && token <= 57) return parseBytes();
    if (token === 105) return parseInteger();
    if (token === 108) return parseList(depth);
    if (token === 100) return parseDictionary(depth);
    throw failure('bencode_token_invalid');
  };

  const parseBytes = (): Buffer => {
    const lengthStart = offset;
    while (true) {
      const byte = requireByte();
      if (byte === 58) break;
      if (byte < 48 || byte > 57) throw failure('bencode_length_invalid');
      offset += 1;
    }
    if (offset === lengthStart) throw failure('bencode_length_invalid');
    const lengthBytes = input.subarray(lengthStart, offset);
    if (lengthBytes.length > 1 && lengthBytes[0] === 48) {
      throw failure('bencode_length_noncanonical');
    }
    const length = boundedLength(lengthBytes, limits.maxStringBytes);
    offset += 1;
    const end = offset + length;
    if (end > limits.maxBytes) throw failure('bencode_bytes_exceeded');
    if (end > input.length) throw incomplete();
    const value = Buffer.from(input.subarray(offset, end));
    offset = end;
    return value;
  };

  const parseInteger = (): number | bigint => {
    offset += 1;
    const start = offset;
    while (requireByte() !== 101) offset += 1;
    const encoded = input.subarray(start, offset).toString('ascii');
    offset += 1;
    if (!/^(0|-?[1-9][0-9]*)$/.test(encoded)) {
      throw failure('bencode_integer_noncanonical');
    }
    const value = BigInt(encoded);
    if (value < INTEGER_MIN || value > INTEGER_MAX) {
      throw failure('bencode_integer_out_of_range');
    }
    return value >= BigInt(Number.MIN_SAFE_INTEGER) &&
      value <= BigInt(Number.MAX_SAFE_INTEGER)
      ? Number(value)
      : value;
  };

  const parseList = (depth: number): BencodeValue[] => {
    offset += 1;
    const result: BencodeValue[] = [];
    while (requireByte() !== 101) result.push(parse(depth + 1));
    offset += 1;
    return result;
  };

  const parseDictionary = (depth: number): BencodeDictionary => {
    offset += 1;
    const result: BencodeDictionary = {};
    const seen = new Set<string>();
    const decoder = new TextDecoder('utf-8', { fatal: true });
    while (requireByte() !== 101) {
      const encodedKey = parseBytes();
      const identity = encodedKey.toString('hex');
      if (seen.has(identity)) throw failure('bencode_duplicate_key');
      seen.add(identity);
      let key: string;
      try {
        key = decoder.decode(encodedKey);
      } catch {
        throw failure('bencode_dictionary_key_invalid');
      }
      const value = parse(depth + 1);
      Object.defineProperty(result, key, {
        value,
        enumerable: true,
        configurable: true,
        writable: true
      });
    }
    offset += 1;
    return result;
  };

  const value = parse(0);
  return { value, bytesRead: offset };
}

function checkedInteger(value: number | bigint): bigint {
  if (typeof value === 'number' &&
      (!Number.isSafeInteger(value) || !Number.isFinite(value))) {
    throw failure('bencode_integer_invalid');
  }
  const integer = BigInt(value);
  if (integer < INTEGER_MIN || integer > INTEGER_MAX) {
    throw failure('bencode_integer_out_of_range');
  }
  return integer;
}

function boundedLength(encoded: Buffer, maximum: number): number {
  let length = 0;
  for (const byte of encoded) {
    length = (length * 10) + (byte - 48);
    if (!Number.isSafeInteger(length) || length > maximum) {
      throw failure('bencode_string_exceeded');
    }
  }
  return length;
}

function checkedLimits(options: BencodeLimits): Required<BencodeLimits> {
  return {
    maxDepth: checkedLimit(options.maxDepth, DEFAULT_LIMITS.maxDepth, true),
    maxNodes: checkedLimit(options.maxNodes, DEFAULT_LIMITS.maxNodes),
    maxBytes: checkedLimit(options.maxBytes, DEFAULT_LIMITS.maxBytes),
    maxStringBytes: checkedLimit(
      options.maxStringBytes,
      DEFAULT_LIMITS.maxStringBytes
    )
  };
}

function checkedLimit(
  value: number | undefined,
  fallback: number,
  allowZero = false
): number {
  const candidate = value ?? fallback;
  if (!Number.isSafeInteger(candidate) ||
      candidate < (allowZero ? 0 : 1) ||
      candidate > 1024 * 1024 * 1024) {
    throw failure('bencode_limit_invalid');
  }
  return candidate;
}

function enterContainer(value: object, active: Set<object>): void {
  if (active.has(value)) throw failure('bencode_cycle');
  active.add(value);
}

function encodedDictionaryKey(value: string): Buffer {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) {
        throw failure('bencode_dictionary_key_invalid');
      }
      index += 1;
      continue;
    }
    if (code >= 0xdc00 && code <= 0xdfff) {
      throw failure('bencode_dictionary_key_invalid');
    }
  }
  return Buffer.from(value, 'utf8');
}

function isDictionary(value: unknown): value is BencodeDictionary {
  if (!value || typeof value !== 'object') return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function incomplete(): BencodeError {
  return new BencodeError('bencode_incomplete', { incomplete: true });
}

function failure(code: string): BencodeError {
  return new BencodeError(code);
}
