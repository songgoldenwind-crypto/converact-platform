import { types as utilTypes } from 'node:util';

export type ClosedSchemaErrorFactory = () => Error;

export function snapshotClosedRecord(
  value: unknown,
  expectedKeys: readonly string[],
  errorFactory: ClosedSchemaErrorFactory
): Readonly<Record<string, unknown>> {
  return snapshotClosedShape(value, expectedKeys, [], errorFactory);
}

export function snapshotClosedShape(
  value: unknown,
  requiredKeys: readonly string[],
  optionalKeys: readonly string[],
  errorFactory: ClosedSchemaErrorFactory
): Readonly<Record<string, unknown>> {
  if (!value || typeof value !== 'object' || utilTypes.isProxy(value) ||
      Array.isArray(value)) {
    throw errorFactory();
  }

  try {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw errorFactory();
    }
    const keys = Reflect.ownKeys(value);
    if (keys.length < requiredKeys.length ||
        keys.length > requiredKeys.length + optionalKeys.length ||
        keys.some((key) =>
          typeof key !== 'string' ||
          (!requiredKeys.includes(key) && !optionalKeys.includes(key)))) {
      throw errorFactory();
    }

    const snapshot: Record<string, unknown> = Object.create(null);
    for (const key of keys as string[]) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !descriptor.enumerable ||
          !Object.hasOwn(descriptor, 'value')) {
        throw errorFactory();
      }
      snapshot[key] = descriptor.value;
    }
    for (let index = 0; index < requiredKeys.length; index += 1) {
      if (!Object.hasOwn(snapshot, requiredKeys[index]!)) {
        throw errorFactory();
      }
    }
    return Object.freeze(snapshot);
  } catch {
    throw errorFactory();
  }
}

export function snapshotClosedArray(
  value: unknown,
  maximumLength: number,
  errorFactory: ClosedSchemaErrorFactory
): readonly unknown[] {
  if (utilTypes.isProxy(value) || !Array.isArray(value)) {
    throw errorFactory();
  }

  try {
    if (Object.getPrototypeOf(value) !== Array.prototype) {
      throw errorFactory();
    }
    const lengthDescriptor = Object.getOwnPropertyDescriptor(value, 'length');
    const length = lengthDescriptor?.value;
    if (!Number.isSafeInteger(length) ||
        Number(length) < 0 ||
        Number(length) > maximumLength) {
      throw errorFactory();
    }
    const keys = Reflect.ownKeys(value);
    if (
        keys.length !== Number(length) + 1 ||
        keys.some((key) =>
          typeof key !== 'string' ||
          (key !== 'length' && !/^(?:0|[1-9][0-9]*)$/.test(key)))) {
      throw errorFactory();
    }

    const snapshot: unknown[] = [];
    for (let index = 0; index < Number(length); index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(
        value,
        String(index)
      );
      if (!descriptor || !descriptor.enumerable ||
          !Object.hasOwn(descriptor, 'value')) {
        throw errorFactory();
      }
      snapshot.push(descriptor.value);
    }
    return Object.freeze(snapshot);
  } catch {
    throw errorFactory();
  }
}

export function snapshotDataRecord(
  value: unknown,
  maximumKeys: number,
  errorFactory: ClosedSchemaErrorFactory
): Readonly<Record<string, unknown>> {
  if (!value || typeof value !== 'object' || utilTypes.isProxy(value) ||
      Array.isArray(value)) {
    throw errorFactory();
  }

  try {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw errorFactory();
    }
    const keys = Reflect.ownKeys(value);
    if (keys.length > maximumKeys ||
        keys.some((key) => typeof key !== 'string')) {
      throw errorFactory();
    }
    const snapshot: Record<string, unknown> = Object.create(null);
    for (const key of keys as string[]) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !descriptor.enumerable ||
          !Object.hasOwn(descriptor, 'value')) {
        throw errorFactory();
      }
      snapshot[key] = descriptor.value;
    }
    return Object.freeze(snapshot);
  } catch {
    throw errorFactory();
  }
}

const TYPED_ARRAY_PROTOTYPE = Object.getPrototypeOf(Uint8Array.prototype);
const TYPED_ARRAY_LENGTH_GETTER = Object.getOwnPropertyDescriptor(
  TYPED_ARRAY_PROTOTYPE,
  'length'
)?.get;
const TYPED_ARRAY_BUFFER_GETTER = Object.getOwnPropertyDescriptor(
  TYPED_ARRAY_PROTOTYPE,
  'buffer'
)?.get;
const TYPED_ARRAY_BYTE_OFFSET_GETTER = Object.getOwnPropertyDescriptor(
  TYPED_ARRAY_PROTOTYPE,
  'byteOffset'
)?.get;
const TYPED_ARRAY_SET = Uint8Array.prototype.set;
const ARRAY_BUFFER_BYTE_LENGTH_GETTER = Object.getOwnPropertyDescriptor(
  ArrayBuffer.prototype,
  'byteLength'
)?.get;
const BYTE_VIEW_SHADOW_KEYS = [
  'length',
  'byteLength',
  'byteOffset',
  'buffer',
  'constructor'
] as const;

export function snapshotClosedBytes(
  value: unknown,
  minimumLength: number,
  maximumLength: number,
  errorFactory: ClosedSchemaErrorFactory
): Buffer {
  if (utilTypes.isProxy(value) || !utilTypes.isUint8Array(value) ||
      (Object.getPrototypeOf(value) !== Uint8Array.prototype &&
       Object.getPrototypeOf(value) !== Buffer.prototype) ||
      !TYPED_ARRAY_LENGTH_GETTER ||
      !TYPED_ARRAY_BUFFER_GETTER ||
      !TYPED_ARRAY_BYTE_OFFSET_GETTER ||
      !ARRAY_BUFFER_BYTE_LENGTH_GETTER) {
    throw errorFactory();
  }

  try {
    const length = TYPED_ARRAY_LENGTH_GETTER.call(value);
    if (!Number.isSafeInteger(length) ||
        length < minimumLength ||
        length > maximumLength) {
      throw errorFactory();
    }
    if (Object.getOwnPropertyDescriptor(value, Symbol.iterator)) {
      throw errorFactory();
    }
    for (let index = 0; index < BYTE_VIEW_SHADOW_KEYS.length; index += 1) {
      if (Object.getOwnPropertyDescriptor(
        value,
        BYTE_VIEW_SHADOW_KEYS[index]!
      )) {
        throw errorFactory();
      }
    }
    const buffer = TYPED_ARRAY_BUFFER_GETTER.call(value);
    const byteOffset = TYPED_ARRAY_BYTE_OFFSET_GETTER.call(value);
    if (!utilTypes.isArrayBuffer(buffer) ||
        utilTypes.isSharedArrayBuffer(buffer) ||
        Object.getPrototypeOf(buffer) !== ArrayBuffer.prototype ||
        !Number.isSafeInteger(byteOffset) ||
        byteOffset < 0 ||
        byteOffset + length >
          ARRAY_BUFFER_BYTE_LENGTH_GETTER.call(buffer)) {
      throw errorFactory();
    }
    const snapshot = Buffer.allocUnsafe(length);
    TYPED_ARRAY_SET.call(snapshot, value);
    return snapshot;
  } catch {
    throw errorFactory();
  }
}
