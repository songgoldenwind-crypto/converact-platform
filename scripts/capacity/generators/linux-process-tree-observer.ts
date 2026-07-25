import { createHash } from 'node:crypto';
import {
  readdir,
  readFile
} from 'node:fs/promises';

export interface LinuxProcessRecord {
  pid: number;
  ppid: number;
  cpu_ticks: number;
}

export interface LinuxNetworkDeviceStats {
  rx_bytes: number;
  tx_bytes: number;
  drop_count: number;
}

export interface LinuxProcessTreeSnapshot {
  captured_at_ms: number;
  host_cpu_ticks: number;
  host_idle_ticks: number;
  processes: LinuxProcessRecord[];
  network: LinuxNetworkDeviceStats;
}

export interface LinuxProcessTreeInterval {
  cpu_ratio: number;
  host_cpu_ratio: number;
  nic_ratio: number;
}

export interface LinuxHostWitness {
  host_witness_source: 'linux_boot_id_sha256';
  host_boot_id_sha256: string;
}

export interface LinuxProcessTreeObservation {
  generator_observation_source: 'linux_proc_tree';
  generator_observation_sample_count: number;
  generator_network_interface: string;
  generator_nic_capacity_bps: number;
  generator_cpu_p95_ratio: number;
  host_cpu_p95_ratio: number;
  generator_nic_p95_ratio: number;
  host_packet_drop_count: number;
  host_witness_source?: LinuxHostWitness['host_witness_source'];
  host_boot_id_sha256?: string;
}

export interface LinuxProcessTreeObserverOptions {
  root_pid: number;
  interface_name: string;
  nic_capacity_bps: number;
  sample_interval_ms?: number;
  capture?: () => Promise<LinuxProcessTreeSnapshot>;
  read_boot_id?: () => Promise<string>;
}

export function createLinuxHostWitness(rawBootId: string): LinuxHostWitness {
  const bootId = rawBootId.trim();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(bootId)) {
    throw new Error('invalid Linux boot ID');
  }
  return {
    host_witness_source: 'linux_boot_id_sha256',
    host_boot_id_sha256: createHash('sha256').update(bootId.toLowerCase()).digest('hex')
  };
}

export function parseLinuxProcessStat(raw: string): LinuxProcessRecord {
  const firstSpace = raw.indexOf(' ');
  const commandEnd = raw.lastIndexOf(') ');
  if (firstSpace <= 0 || raw[firstSpace + 1] !== '(' || commandEnd <= firstSpace) {
    throw new Error('invalid Linux process stat record');
  }
  const pid = integer(raw.slice(0, firstSpace), 'Linux process PID');
  const fields = raw.slice(commandEnd + 2).trim().split(/\s+/);
  if (fields.length < 13) throw new Error('invalid Linux process stat fields');
  const ppid = integer(fields[1], 'Linux process parent PID');
  const userTicks = integer(fields[11], 'Linux process user ticks');
  const systemTicks = integer(fields[12], 'Linux process system ticks');
  return {
    pid,
    ppid,
    cpu_ticks: userTicks + systemTicks
  };
}

export function parseLinuxHostCpuStat(raw: string): {
  total_ticks: number;
  idle_ticks: number;
} {
  const line = raw.split(/\r?\n/).find((candidate) => candidate.startsWith('cpu '));
  if (!line) throw new Error('Linux aggregate CPU stat is missing');
  const fields = line.trim().split(/\s+/).slice(1, 9);
  if (fields.length !== 8) throw new Error('Linux aggregate CPU stat is invalid');
  const ticks = fields.map((value) => integer(value, 'Linux aggregate CPU ticks'));
  return {
    total_ticks: ticks.reduce((total, value) => total + value, 0),
    idle_ticks: ticks[3] + ticks[4]
  };
}

export function parseLinuxHostCpuTicks(raw: string): number {
  return parseLinuxHostCpuStat(raw).total_ticks;
}

export function parseLinuxNetworkDeviceStats(
  raw: string,
  interfaceName: string
): LinuxNetworkDeviceStats {
  networkInterface(interfaceName);
  const line = raw.split(/\r?\n/).find((candidate) => {
    const separator = candidate.indexOf(':');
    return separator >= 0 && candidate.slice(0, separator).trim() === interfaceName;
  });
  if (!line) throw new Error(`Linux network interface ${interfaceName} is missing`);
  const separator = line.indexOf(':');
  const fields = line.slice(separator + 1).trim().split(/\s+/);
  if (fields.length < 16) throw new Error(`Linux network interface ${interfaceName} is invalid`);
  return {
    rx_bytes: integer(fields[0], 'Linux network receive bytes'),
    tx_bytes: integer(fields[8], 'Linux network transmit bytes'),
    drop_count:
      integer(fields[3], 'Linux network receive drops') +
      integer(fields[11], 'Linux network transmit drops')
  };
}

export async function readLinuxProcessRecords(
  entries: readonly string[],
  readStat: (pid: number) => Promise<string> =
    (pid) => readFile(`/proc/${pid}/stat`, 'utf8')
): Promise<LinuxProcessRecord[]> {
  return (await Promise.all(entries
    .filter((entry) => /^[1-9][0-9]*$/.test(entry))
    .map(async (entry): Promise<LinuxProcessRecord | null> => {
      try {
        return parseLinuxProcessStat(await readStat(Number(entry)));
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === 'ENOENT' || code === 'ESRCH' ||
            code === 'EACCES' || code === 'EPERM') return null;
        throw error;
      }
    })))
    .filter((record): record is LinuxProcessRecord => record !== null);
}

export function calculateLinuxProcessTreeInterval(
  previous: LinuxProcessTreeSnapshot,
  current: LinuxProcessTreeSnapshot,
  rootPid: number,
  nicCapacityBps: number
): LinuxProcessTreeInterval {
  positiveInteger(rootPid, 'Linux process-tree root PID');
  positiveInteger(nicCapacityBps, 'Linux NIC capacity');
  const elapsedSeconds = (current.captured_at_ms - previous.captured_at_ms) / 1_000;
  const hostTickDelta = current.host_cpu_ticks - previous.host_cpu_ticks;
  const hostIdleTickDelta = current.host_idle_ticks - previous.host_idle_ticks;
  if (!Number.isFinite(elapsedSeconds) || elapsedSeconds <= 0 || hostTickDelta <= 0) {
    throw new Error('Linux process-tree sample interval is invalid');
  }

  const selected = processTreePids(current.processes, rootPid);
  const previousTicks = new Map(
    previous.processes.map((process) => [process.pid, process.cpu_ticks])
  );
  let processTickDelta = 0;
  for (const process of current.processes) {
    if (!selected.has(process.pid)) continue;
    const delta = process.cpu_ticks - (previousTicks.get(process.pid) || 0);
    if (delta > 0) processTickDelta += delta;
  }

  const rxBytes = Math.max(0, current.network.rx_bytes - previous.network.rx_bytes);
  const txBytes = Math.max(0, current.network.tx_bytes - previous.network.tx_bytes);
  const directionalBps = Math.max(rxBytes, txBytes) * 8 / elapsedSeconds;
  return {
    cpu_ratio: clampRatio(processTickDelta / hostTickDelta),
    host_cpu_ratio: clampRatio(1 - Math.max(0, hostIdleTickDelta) / hostTickDelta),
    nic_ratio: clampRatio(directionalBps / nicCapacityBps)
  };
}

export function summarizeLinuxProcessTreeIntervals(input: {
  interface_name: string;
  nic_capacity_bps: number;
  initial_drop_count: number;
  final_drop_count: number;
  intervals: readonly LinuxProcessTreeInterval[];
  host_witness?: LinuxHostWitness;
}): LinuxProcessTreeObservation {
  networkInterface(input.interface_name);
  positiveInteger(input.nic_capacity_bps, 'Linux NIC capacity');
  nonNegativeInteger(input.initial_drop_count, 'Linux initial packet drops');
  nonNegativeInteger(input.final_drop_count, 'Linux final packet drops');
  if (input.intervals.length === 0) {
    throw new Error('Linux process-tree observation has no intervals');
  }
  for (const interval of input.intervals) {
    ratio(interval.cpu_ratio, 'Linux process-tree CPU ratio');
    ratio(interval.host_cpu_ratio, 'Linux host CPU ratio');
    ratio(interval.nic_ratio, 'Linux process-tree NIC ratio');
  }
  return {
    generator_observation_source: 'linux_proc_tree',
    generator_observation_sample_count: input.intervals.length,
    generator_network_interface: input.interface_name,
    generator_nic_capacity_bps: input.nic_capacity_bps,
    generator_cpu_p95_ratio: percentile(
      input.intervals.map((interval) => interval.cpu_ratio),
      0.95
    ),
    host_cpu_p95_ratio: percentile(
      input.intervals.map((interval) => interval.host_cpu_ratio),
      0.95
    ),
    generator_nic_p95_ratio: percentile(
      input.intervals.map((interval) => interval.nic_ratio),
      0.95
    ),
    host_packet_drop_count: Math.max(0, input.final_drop_count - input.initial_drop_count),
    ...(input.host_witness || {})
  };
}

export async function captureLinuxProcessTreeSnapshot(
  interfaceName: string
): Promise<LinuxProcessTreeSnapshot> {
  networkInterface(interfaceName);
  const [hostRaw, networkRaw, entries] = await Promise.all([
    readFile('/proc/stat', 'utf8'),
    readFile('/proc/net/dev', 'utf8'),
    readdir('/proc')
  ]);
  const processes = await readLinuxProcessRecords(entries);
  const host = parseLinuxHostCpuStat(hostRaw);
  return {
    captured_at_ms: performance.now(),
    host_cpu_ticks: host.total_ticks,
    host_idle_ticks: host.idle_ticks,
    processes,
    network: parseLinuxNetworkDeviceStats(networkRaw, interfaceName)
  };
}

export class LinuxProcessTreeObserver {
  readonly #rootPid: number;
  readonly #interfaceName: string;
  readonly #nicCapacityBps: number;
  readonly #sampleIntervalMs: number;
  readonly #capture: () => Promise<LinuxProcessTreeSnapshot>;
  readonly #readBootId: () => Promise<string>;
  #previous: LinuxProcessTreeSnapshot | null = null;
  #hostWitness: LinuxHostWitness | null = null;
  #intervals: LinuxProcessTreeInterval[] = [];
  #timer: NodeJS.Timeout | null = null;
  #pending: Promise<void> = Promise.resolve();
  #sampleError: unknown;
  #initialDropCount: number | null = null;

  constructor(options: LinuxProcessTreeObserverOptions) {
    positiveInteger(options.root_pid, 'Linux process-tree root PID');
    networkInterface(options.interface_name);
    positiveInteger(options.nic_capacity_bps, 'Linux NIC capacity');
    const sampleInterval = options.sample_interval_ms ?? 1_000;
    boundedInteger(sampleInterval, 100, 10_000, 'Linux process-tree sample interval');
    this.#rootPid = options.root_pid;
    this.#interfaceName = options.interface_name;
    this.#nicCapacityBps = options.nic_capacity_bps;
    this.#sampleIntervalMs = sampleInterval;
    this.#capture = options.capture ||
      (() => captureLinuxProcessTreeSnapshot(this.#interfaceName));
    this.#readBootId = options.read_boot_id ||
      (() => readFile('/proc/sys/kernel/random/boot_id', 'utf8'));
  }

  async start(): Promise<void> {
    if (this.#previous || this.#timer) {
      throw new Error('Linux process-tree observer is already started');
    }
    const [snapshot, rawBootId] = await Promise.all([
      this.#capture(),
      this.#readBootId()
    ]);
    this.#previous = snapshot;
    this.#hostWitness = createLinuxHostWitness(rawBootId);
    this.#initialDropCount = this.#previous.network.drop_count;
    this.#timer = setInterval(() => this.#queueSample(), this.#sampleIntervalMs);
  }

  async stop(): Promise<LinuxProcessTreeObservation> {
    if (!this.#previous) throw new Error('Linux process-tree observer is not started');
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = null;
    await this.#pending;
    if (this.#sampleError) throw this.#sampleError;
    await this.#sample();
    if (this.#sampleError) throw this.#sampleError;
    if (this.#intervals.length === 0) {
      await new Promise((resolve) => setTimeout(resolve, this.#sampleIntervalMs));
      await this.#sample();
    }
    return summarizeLinuxProcessTreeIntervals({
      interface_name: this.#interfaceName,
      nic_capacity_bps: this.#nicCapacityBps,
      initial_drop_count: this.#initialDropCount as number,
      final_drop_count: this.#previous.network.drop_count,
      intervals: this.#intervals,
      host_witness: this.#hostWitness as LinuxHostWitness
    });
  }

  #queueSample(): void {
    this.#pending = this.#pending.then(async () => {
      if (this.#sampleError) return;
      try {
        await this.#sample();
      } catch (error) {
        this.#sampleError = error;
      }
    });
  }

  async #sample(): Promise<void> {
    if (!this.#previous) throw new Error('Linux process-tree observer is not started');
    const previous = this.#previous;
    const current = await this.#capture();
    this.#previous = current;
    if (current.captured_at_ms <= previous.captured_at_ms ||
        current.host_cpu_ticks <= previous.host_cpu_ticks) return;
    this.#intervals.push(calculateLinuxProcessTreeInterval(
      previous,
      current,
      this.#rootPid,
      this.#nicCapacityBps
    ));
  }
}

function processTreePids(processes: readonly LinuxProcessRecord[], rootPid: number): Set<number> {
  const children = new Map<number, number[]>();
  for (const process of processes) {
    const siblings = children.get(process.ppid) || [];
    siblings.push(process.pid);
    children.set(process.ppid, siblings);
  }
  const selected = new Set<number>([rootPid]);
  const pending = [rootPid];
  while (pending.length > 0) {
    const parent = pending.pop() as number;
    for (const child of children.get(parent) || []) {
      if (selected.has(child)) continue;
      selected.add(child);
      pending.push(child);
    }
  }
  return selected;
}

function percentile(values: readonly number[], quantile: number): number {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.max(0, Math.ceil(sorted.length * quantile) - 1)];
}

function networkInterface(value: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,14}$/.test(value)) {
    throw new Error('invalid Linux network interface');
  }
}

function integer(value: unknown, label: string): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error(`invalid ${label}`);
  return parsed;
}

function positiveInteger(value: unknown, label: string): void {
  if (!Number.isSafeInteger(value) || Number(value) <= 0) throw new Error(`invalid ${label}`);
}

function nonNegativeInteger(value: unknown, label: string): void {
  if (!Number.isSafeInteger(value) || Number(value) < 0) throw new Error(`invalid ${label}`);
}

function boundedInteger(value: unknown, minimum: number, maximum: number, label: string): void {
  if (!Number.isInteger(value) || Number(value) < minimum || Number(value) > maximum) {
    throw new Error(`invalid ${label}`);
  }
}

function ratio(value: number, label: string): void {
  if (!Number.isFinite(value) || value < 0 || value > 1) throw new Error(`invalid ${label}`);
}

function clampRatio(value: number): number {
  return Math.max(0, Math.min(1, value));
}
