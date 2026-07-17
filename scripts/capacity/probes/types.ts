export type CapacityComponent =
  | 'ivekit_edge'
  | 'tinode'
  | 'rustpbx'
  | 'livekit'
  | 'rustdesk';

export type ComponentCapacityState = 'accepting' | 'draining' | 'degraded' | 'offline';
export type ComponentCapacityProbeOutcome = 'observed' | 'failed' | 'not_run';

export interface ComponentCapacityDimension {
  unit: string;
  safe_capacity: number;
  used: number;
  reserved: number;
  utilization: number;
}

export interface ComponentCapacityObservation {
  schema_version: '1.0.0';
  outcome: ComponentCapacityProbeOutcome;
  component: CapacityComponent;
  instance_id: string;
  region_id: string;
  zone_id: string;
  cell_id: string;
  release_id: string;
  hardware_class: string;
  configuration_class: string;
  profile_id: string;
  profile_sha256: string;
  state: ComponentCapacityState;
  observed_at: string;
  dominant_utilization: number;
  dimensions: Record<string, ComponentCapacityDimension>;
  reasons: string[];
  evidence: {
    sha256: string;
    byte_size: number;
    health_status: number;
    metrics_status: number;
    captured_at: string;
  };
}

export interface CapacityMetricBinding {
  metric: string;
  aggregation: 'sum' | 'max' | 'min';
  unit: string;
  safe_capacity: number;
  labels?: Record<string, string>;
}

export type CapacityProbeFetch = (
  input: string | URL,
  init?: RequestInit
) => Promise<Response>;

export interface ComponentCapacityProbeConfig {
  component: CapacityComponent;
  instance_id: string;
  region_id: string;
  zone_id: string;
  cell_id: string;
  release_id: string;
  hardware_class: string;
  configuration_class: string;
  profile_id: string;
  profile_sha256: string;
  health_url: string;
  metrics_url: string;
  drain_metric?: string;
  dimensions: Record<string, CapacityMetricBinding>;
  timeout_ms?: number;
  fetch?: CapacityProbeFetch;
}

export interface ComponentCapacityProbe {
  collect(now?: Date): Promise<ComponentCapacityObservation>;
}
