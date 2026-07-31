import type {
  IveKitRateLimitDecision,
  IveKitRateLimitReservationInput
} from './types.js';

export interface IveKitRateLimitRepository {
  reserve(input: IveKitRateLimitReservationInput): Promise<IveKitRateLimitDecision>;
}
