export type IveKitRateLimitScope =
  | 'tenant' | 'actor' | 'source_ip' | 'recipient' | 'provider';

export interface IveKitRateLimitDimension {
  scope_type: IveKitRateLimitScope;
  key: string;
  limit: number;
  window_seconds: number;
  cost?: number;
}

export interface IveKitRateLimitCheckInput {
  tenant_id: string;
  route_group: string;
  dimensions: IveKitRateLimitDimension[];
}

export interface IveKitRateLimitReservationDimension {
  scope_type: IveKitRateLimitScope;
  scope_key_hmac: string;
  limit: number;
  window_seconds: number;
  cost: number;
}

export interface IveKitRateLimitReservationInput {
  tenant_id: string;
  route_group: string;
  dimensions: IveKitRateLimitReservationDimension[];
  now: string;
}

export interface IveKitRateLimitDecision {
  allowed: boolean;
  retry_after_seconds: number;
  denied_scope: IveKitRateLimitScope | null;
}
