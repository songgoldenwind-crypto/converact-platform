export type ConveractFabricRateLimitScope =
  | 'tenant' | 'actor' | 'source_ip' | 'recipient' | 'provider';

export interface ConveractFabricRateLimitDimension {
  scope_type: ConveractFabricRateLimitScope;
  key: string;
  limit: number;
  window_seconds: number;
  cost?: number;
}

export interface ConveractFabricRateLimitCheckInput {
  tenant_id: string;
  route_group: string;
  dimensions: ConveractFabricRateLimitDimension[];
}

export interface ConveractFabricRateLimitReservationDimension {
  scope_type: ConveractFabricRateLimitScope;
  scope_key_hmac: string;
  limit: number;
  window_seconds: number;
  cost: number;
}

export interface ConveractFabricRateLimitReservationInput {
  tenant_id: string;
  route_group: string;
  dimensions: ConveractFabricRateLimitReservationDimension[];
  now: string;
}

export interface ConveractFabricRateLimitDecision {
  allowed: boolean;
  retry_after_seconds: number;
  denied_scope: ConveractFabricRateLimitScope | null;
}
