import type {
  ConveractFabricRateLimitDecision,
  ConveractFabricRateLimitReservationInput
} from './types.js';

export interface ConveractFabricRateLimitRepository {
  reserve(input: ConveractFabricRateLimitReservationInput): Promise<ConveractFabricRateLimitDecision>;
}
