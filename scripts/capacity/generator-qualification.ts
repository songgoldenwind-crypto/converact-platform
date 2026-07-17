import { deepFreeze } from './canonical-json.js';

export interface GeneratorWorkerCapacity {
  worker_id: string;
  protocol: string;
  release_id: string;
  hardware_class: string;
  calibrated: boolean;
  safe_capacity: number;
  assigned_load: number;
  cpu_p95_ratio: number;
  memory_p95_ratio: number;
  nic_p95_ratio: number;
  host_packet_drop_count: number;
  scheduler_lag_p99_ms: number;
  scheduler_lag_limit_ms: number;
}

export interface GeneratorFleetQualification {
  fleet_id: string;
  status: 'qualified' | 'invalid_generator_capacity';
  target_load: number;
  assigned_load: number;
  total_safe_capacity: number;
  required_safe_capacity: number;
  headroom_ratio: number;
  workers: GeneratorWorkerCapacity[];
  reasons: string[];
}

export function qualifyGeneratorFleet(input: {
  fleet_id: string;
  target_load: number;
  workers: GeneratorWorkerCapacity[];
}): Readonly<GeneratorFleetQualification> {
  if (!input.fleet_id) throw new Error('fleet ID is required');
  if (!Number.isFinite(input.target_load) || input.target_load <= 0) {
    throw new Error('generator target load must be positive');
  }
  if (input.workers.length === 0) throw new Error('generator fleet requires workers');

  const reasons: string[] = [];
  const workerIds = new Set<string>();
  const first = input.workers[0];
  let totalSafeCapacity = 0;
  let assignedLoad = 0;
  for (const worker of input.workers) {
    validateWorkerNumbers(worker);
    if (!worker.worker_id || workerIds.has(worker.worker_id)) {
      reasons.push(`worker IDs must be non-empty and unique: ${worker.worker_id || '<empty>'}`);
    }
    workerIds.add(worker.worker_id);
    if (worker.protocol !== first.protocol || worker.release_id !== first.release_id ||
        worker.hardware_class !== first.hardware_class) {
      reasons.push(`worker ${worker.worker_id} calibration identity differs from its fleet`);
    }
    if (!worker.calibrated) reasons.push(`worker ${worker.worker_id} has no safe-capacity calibration`);
    if (worker.assigned_load > worker.safe_capacity * 0.7 + Number.EPSILON) {
      reasons.push(`worker ${worker.worker_id} assignment exceeds 70% of safe capacity`);
    }
    if (worker.assigned_load > input.target_load * 0.2 + Number.EPSILON) {
      reasons.push(`worker ${worker.worker_id} carries more than 20% of fleet target`);
    }
    if (worker.cpu_p95_ratio > 0.6) reasons.push(`worker ${worker.worker_id} CPU P95 exceeds 60%`);
    if (worker.memory_p95_ratio > 0.7) reasons.push(`worker ${worker.worker_id} memory P95 exceeds 70%`);
    if (worker.nic_p95_ratio > 0.7) reasons.push(`worker ${worker.worker_id} NIC P95 exceeds 70%`);
    if (worker.host_packet_drop_count !== 0) reasons.push(`worker ${worker.worker_id} has host packet drop`);
    if (worker.scheduler_lag_p99_ms > worker.scheduler_lag_limit_ms) {
      reasons.push(`worker ${worker.worker_id} scheduler lag exceeds calibration limit`);
    }
    totalSafeCapacity += worker.safe_capacity;
    assignedLoad += worker.assigned_load;
  }
  const requiredSafeCapacity = input.target_load * 1.5;
  if (totalSafeCapacity + Number.EPSILON < requiredSafeCapacity) {
    reasons.push(`fleet safe capacity must be at least 150% of target (${requiredSafeCapacity})`);
  }
  if (Math.abs(assignedLoad - input.target_load) > Math.max(1e-9, input.target_load * 1e-9)) {
    reasons.push(`fleet assigned load ${assignedLoad} does not equal target ${input.target_load}`);
  }

  return deepFreeze({
    fleet_id: input.fleet_id,
    status: reasons.length === 0 ? 'qualified' : 'invalid_generator_capacity',
    target_load: input.target_load,
    assigned_load: assignedLoad,
    total_safe_capacity: totalSafeCapacity,
    required_safe_capacity: requiredSafeCapacity,
    headroom_ratio: totalSafeCapacity / input.target_load,
    workers: structuredClone(input.workers),
    reasons
  }) as Readonly<GeneratorFleetQualification>;
}

function validateWorkerNumbers(worker: GeneratorWorkerCapacity): void {
  for (const [field, value] of Object.entries({
    safe_capacity: worker.safe_capacity,
    assigned_load: worker.assigned_load,
    cpu_p95_ratio: worker.cpu_p95_ratio,
    memory_p95_ratio: worker.memory_p95_ratio,
    nic_p95_ratio: worker.nic_p95_ratio,
    host_packet_drop_count: worker.host_packet_drop_count,
    scheduler_lag_p99_ms: worker.scheduler_lag_p99_ms,
    scheduler_lag_limit_ms: worker.scheduler_lag_limit_ms
  })) {
    if (!Number.isFinite(value) || value < 0) throw new Error(`worker ${worker.worker_id} has invalid ${field}`);
  }
  for (const [field, ratio] of Object.entries({
    cpu_p95_ratio: worker.cpu_p95_ratio,
    memory_p95_ratio: worker.memory_p95_ratio,
    nic_p95_ratio: worker.nic_p95_ratio
  })) {
    if (ratio > 1) throw new Error(`worker ${worker.worker_id} has invalid ${field}`);
  }
}

