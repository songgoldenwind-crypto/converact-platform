import { PlacementError } from './types.js';

const UINT32_MAX = (1n << 32n) - 1n;
const UINT64_MAX = (1n << 64n) - 1n;

export function composeOwnerEpoch(
  cellLeaseEpoch: number | bigint,
  cellLocalSequence: number | bigint
): string {
  const lease = uint32(cellLeaseEpoch, 'cell lease epoch', 1n);
  const sequence = uint32(cellLocalSequence, 'cell local sequence', 1n);
  return ((lease << 32n) | sequence).toString();
}

export function splitOwnerEpoch(value: string): {
  cell_lease_epoch: number;
  cell_local_sequence: number;
} {
  const epoch = ownerEpoch(value);
  return {
    cell_lease_epoch: Number(epoch >> 32n),
    cell_local_sequence: Number(epoch & UINT32_MAX)
  };
}

export function compareOwnerEpoch(left: string, right: string): -1 | 0 | 1 {
  const leftEpoch = ownerEpoch(left);
  const rightEpoch = ownerEpoch(right);
  return leftEpoch < rightEpoch ? -1 : leftEpoch > rightEpoch ? 1 : 0;
}

export function assertCurrentOwnerEpoch(provided: string, current: string): void {
  const comparison = compareOwnerEpoch(provided, current);
  if (comparison < 0) {
    throw new PlacementError({
      code: 'stale_owner_epoch',
      status: 409,
      details: { provided_epoch: provided, current_epoch: current }
    });
  }
  if (comparison > 0) {
    throw new PlacementError({
      code: 'owner_epoch_ahead',
      status: 409,
      retryable: true,
      details: { provided_epoch: provided, current_epoch: current }
    });
  }
}

function ownerEpoch(value: string): bigint {
  if (!/^(?:0|[1-9]\d{0,19})$/.test(value)) throw new Error('invalid owner epoch');
  const parsed = BigInt(value);
  if (parsed < 0n || parsed > UINT64_MAX) throw new Error('invalid owner epoch');
  return parsed;
}

function uint32(
  value: number | bigint,
  label: string,
  minimum: bigint
): bigint {
  if (typeof value === 'number' && !Number.isSafeInteger(value)) {
    throw new Error(`${label} must be an unsigned 32-bit integer`);
  }
  const parsed = BigInt(value);
  if (parsed < minimum || parsed > UINT32_MAX) {
    throw new Error(`${label} must be an unsigned 32-bit integer`);
  }
  return parsed;
}

