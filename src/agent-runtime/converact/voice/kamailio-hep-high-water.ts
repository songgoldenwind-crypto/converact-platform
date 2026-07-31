export type KamailioHepMode = 'full' | 'sampled' | 'off';

export interface KamailioHepHighWaterPolicy {
  sample_percent: number;
  queue_sample_ratio: number;
  queue_off_ratio: number;
  queue_recover_ratio: number;
  cpu_sample_cores: number;
  cpu_off_cores: number;
  cpu_recover_cores: number;
  packets_sample_per_second: number;
  packets_off_per_second: number;
  packets_recover_per_second: number;
  processing_gap_sample_per_second: number;
  processing_gap_off_per_second: number;
  processing_gap_recover_per_second: number;
  failure_samples_to_off: number;
  recovery_samples: number;
}

export interface HomerHepObservation {
  collector_up: boolean;
  queue_ratio: number | null;
  cpu_cores: number | null;
  packets_per_second: number | null;
  processing_gap_per_second: number | null;
}

export interface KamailioHepDecision {
  previous_mode: KamailioHepMode;
  mode: KamailioHepMode;
  changed: boolean;
  reason: string;
  sample_buckets: number;
}

export interface KamailioHepControlInput {
  mode: KamailioHepMode;
  sample_buckets: number;
  revision: number;
}

export interface KamailioHepControlPort {
  read_revision(): Promise<number>;
  apply(input: KamailioHepControlInput): Promise<void>;
}

interface HomerMetricsSnapshot {
  observed_at_ms: number;
  process_start_time_seconds: number;
  process_cpu_seconds_total: number;
  packets_received_total: number;
  packets_processed_total: number;
}

const HEP_SAMPLE_BUCKET_COUNT = 1_024;
const MAXIMUM_HOMER_METRICS_BYTES = 1_048_576;

export class KamailioHepHighWaterStateMachine {
  readonly #policy: KamailioHepHighWaterPolicy;
  readonly #sampleBuckets: number;
  #mode: KamailioHepMode;
  #collectorFailures = 0;
  #recoverySamples = 0;

  constructor(
    policy: KamailioHepHighWaterPolicy,
    initialMode: KamailioHepMode = 'full'
  ) {
    this.#policy = checkedPolicy(policy);
    this.#mode = initialMode;
    this.#sampleBuckets = Math.max(
      1,
      Math.floor((this.#policy.sample_percent / 100) * HEP_SAMPLE_BUCKET_COUNT)
    );
  }

  status(): { mode: KamailioHepMode; sample_buckets: number } {
    return { mode: this.#mode, sample_buckets: this.#sampleBuckets };
  }

  observe(rawObservation: HomerHepObservation): KamailioHepDecision {
    const observation = checkedObservation(rawObservation);
    const previous = this.#mode;
    const pressure = this.#pressure(observation);

    if (!observation.collector_up) {
      this.#collectorFailures += 1;
      this.#recoverySamples = 0;
      this.#mode = this.#collectorFailures >= this.#policy.failure_samples_to_off
        ? 'off'
        : maximumPressureMode(this.#mode, 'sampled');
    } else {
      this.#collectorFailures = 0;
      const currentRank = modeRank(this.#mode);
      const pressureRank = modeRank(pressure.mode);
      if (pressureRank > currentRank) {
        this.#mode = pressure.mode;
        this.#recoverySamples = 0;
      } else if (pressureRank === currentRank) {
        this.#recoverySamples = 0;
      } else if (this.#isRecoverySafe(observation)) {
        this.#recoverySamples += 1;
        if (this.#recoverySamples >= this.#policy.recovery_samples) {
          this.#mode = this.#mode === 'off' ? 'sampled' : 'full';
          this.#recoverySamples = 0;
        }
      } else {
        this.#recoverySamples = 0;
      }
    }

    return {
      previous_mode: previous,
      mode: this.#mode,
      changed: previous !== this.#mode,
      reason: observation.collector_up
        ? (previous !== this.#mode && modeRank(this.#mode) < modeRank(previous)
            ? 'recovery_hysteresis'
            : pressure.reason)
        : 'collector_unavailable',
      sample_buckets: this.#sampleBuckets
    };
  }

  #pressure(observation: HomerHepObservation): {
    mode: KamailioHepMode;
    reason: string;
  } {
    if (atLeast(observation.queue_ratio, this.#policy.queue_off_ratio)) {
      return { mode: 'off', reason: 'collector_queue_critical' };
    }
    if (atLeast(observation.cpu_cores, this.#policy.cpu_off_cores)) {
      return { mode: 'off', reason: 'collector_cpu_critical' };
    }
    if (atLeast(observation.packets_per_second, this.#policy.packets_off_per_second)) {
      return { mode: 'off', reason: 'collector_packet_rate_critical' };
    }
    if (atLeast(
      observation.processing_gap_per_second,
      this.#policy.processing_gap_off_per_second
    )) {
      return { mode: 'off', reason: 'collector_processing_gap_critical' };
    }
    if (atLeast(observation.queue_ratio, this.#policy.queue_sample_ratio)) {
      return { mode: 'sampled', reason: 'collector_queue_high' };
    }
    if (atLeast(observation.cpu_cores, this.#policy.cpu_sample_cores)) {
      return { mode: 'sampled', reason: 'collector_cpu_high' };
    }
    if (atLeast(observation.packets_per_second, this.#policy.packets_sample_per_second)) {
      return { mode: 'sampled', reason: 'collector_packet_rate_high' };
    }
    if (atLeast(
      observation.processing_gap_per_second,
      this.#policy.processing_gap_sample_per_second
    )) {
      return { mode: 'sampled', reason: 'collector_processing_gap_high' };
    }
    return { mode: 'full', reason: 'healthy' };
  }

  #isRecoverySafe(observation: HomerHepObservation): boolean {
    return atMost(observation.queue_ratio, this.#policy.queue_recover_ratio) &&
      atMost(observation.cpu_cores, this.#policy.cpu_recover_cores) &&
      atMost(observation.packets_per_second, this.#policy.packets_recover_per_second) &&
      atMost(
        observation.processing_gap_per_second,
        this.#policy.processing_gap_recover_per_second
      );
  }
}

export class HttpHomerMetricsClient {
  readonly #endpoint: URL;
  readonly #timeoutMs: number;
  readonly #fetch: typeof fetch;

  constructor(input: {
    endpoint: string;
    timeout_ms?: number;
    fetch?: typeof fetch;
  }) {
    this.#endpoint = checkedHomerMetricsEndpoint(input.endpoint);
    this.#timeoutMs = integer(
      input.timeout_ms ?? 1_000,
      100,
      5_000,
      'HOMER metrics timeout'
    );
    this.#fetch = input.fetch || globalThis.fetch;
  }

  async read(): Promise<string> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.#timeoutMs);
    try {
      const response = await this.#fetch(this.#endpoint, {
        method: 'GET',
        signal: controller.signal,
        headers: { accept: 'text/plain' }
      });
      if (!response.ok) throw new Error(`HOMER metrics returned HTTP ${response.status}`);
      return boundedHomerMetricsResponse(response);
    } finally {
      clearTimeout(timer);
    }
  }
}

export class HomerHepMetricsSampler {
  #previous: HomerMetricsSnapshot | null = null;

  observe(text: string, now: Date): HomerHepObservation {
    if (!(now instanceof Date) || !Number.isFinite(now.getTime())) {
      throw new Error('HOMER metrics observation time is invalid');
    }
    if (!text || Buffer.byteLength(text) > 1_048_576 || text.includes('\0')) {
      throw new Error('HOMER metrics response is empty or too large');
    }
    const queueDepth = requiredMetric(text, 'homer_worker_queue_depth');
    const queueCapacity = requiredMetric(text, 'homer_worker_queue_capacity');
    const current: HomerMetricsSnapshot = {
      observed_at_ms: now.getTime(),
      process_start_time_seconds: requiredMetric(text, 'process_start_time_seconds'),
      process_cpu_seconds_total: requiredMetric(text, 'process_cpu_seconds_total'),
      packets_received_total: requiredMetric(
        text,
        'homer_hep_packets_received_total',
        'protocol',
        'udp'
      ),
      packets_processed_total: requiredMetric(
        text,
        'homer_hep_packets_processed_total',
        'protocol',
        'udp'
      )
    };
    if (queueCapacity <= 0) throw new Error('required HOMER metric queue capacity is invalid');

    const previous = this.#previous;
    this.#previous = current;
    const comparable = previous &&
      previous.process_start_time_seconds === current.process_start_time_seconds &&
      current.observed_at_ms > previous.observed_at_ms &&
      current.process_cpu_seconds_total >= previous.process_cpu_seconds_total &&
      current.packets_received_total >= previous.packets_received_total &&
      current.packets_processed_total >= previous.packets_processed_total;
    if (!comparable) {
      return {
        collector_up: true,
        queue_ratio: queueDepth / queueCapacity,
        cpu_cores: null,
        packets_per_second: null,
        processing_gap_per_second: null
      };
    }

    const elapsedSeconds = (current.observed_at_ms - previous.observed_at_ms) / 1_000;
    const receivedDelta = current.packets_received_total - previous.packets_received_total;
    const processedDelta = current.packets_processed_total - previous.packets_processed_total;
    return {
      collector_up: true,
      queue_ratio: queueDepth / queueCapacity,
      cpu_cores: (current.process_cpu_seconds_total - previous.process_cpu_seconds_total) /
        elapsedSeconds,
      packets_per_second: receivedDelta / elapsedSeconds,
      processing_gap_per_second: Math.max(0, receivedDelta - processedDelta) / elapsedSeconds
    };
  }
}

export class KamailioHepHighWaterController {
  readonly #machine: KamailioHepHighWaterStateMachine;
  readonly #sampler: HomerHepMetricsSampler;
  readonly #readMetrics: () => Promise<string>;
  readonly #control: KamailioHepControlPort;
  #lastObservation: HomerHepObservation = unavailableObservation();
  #lastDecision: KamailioHepDecision;
  #appliedMode: KamailioHepMode | null = null;
  #pendingTransition = false;
  #revision = 0;
  #scrapeFailures = 0;
  #applyFailures = 0;
  #transitions = 0;
  #lastSuccessTimestampSeconds = 0;
  #run: Promise<KamailioHepDecision & { revision: number }> | null = null;

  constructor(input: {
    policy: KamailioHepHighWaterPolicy;
    read_metrics: () => Promise<string>;
    control: KamailioHepControlPort;
    sampler?: HomerHepMetricsSampler;
  }) {
    this.#machine = new KamailioHepHighWaterStateMachine(input.policy, 'off');
    this.#sampler = input.sampler || new HomerHepMetricsSampler();
    this.#readMetrics = input.read_metrics;
    this.#control = input.control;
    const status = this.#machine.status();
    this.#lastDecision = {
      previous_mode: status.mode,
      mode: status.mode,
      changed: false,
      reason: 'not_observed',
      sample_buckets: status.sample_buckets
    };
  }

  runOnce(now: Date): Promise<KamailioHepDecision & { revision: number }> {
    if (this.#run) return this.#run;
    const tracked = this.#runOnce(now).finally(() => {
      if (this.#run === tracked) this.#run = null;
    });
    this.#run = tracked;
    return tracked;
  }

  async #runOnce(now: Date): Promise<KamailioHepDecision & { revision: number }> {
    let observation: HomerHepObservation;
    try {
      observation = this.#sampler.observe(await this.#readMetrics(), now);
      this.#lastSuccessTimestampSeconds = Math.floor(now.getTime() / 1_000);
    } catch {
      this.#scrapeFailures += 1;
      observation = unavailableObservation();
    }
    this.#lastObservation = observation;
    const decision = this.#machine.observe(observation);
    this.#lastDecision = decision;
    if (decision.changed) this.#pendingTransition = true;

    try {
      const remoteRevision = await this.#control.read_revision();
      if (!Number.isSafeInteger(remoteRevision) || remoteRevision < 0) {
        throw new Error('Kamailio HEP control revision is invalid');
      }
      if (remoteRevision !== this.#revision) {
        this.#appliedMode = null;
        this.#pendingTransition = true;
      }

      if (this.#appliedMode !== decision.mode || this.#pendingTransition || this.#revision === 0) {
        const revision = Math.max(this.#revision, remoteRevision) + 1;
        await this.#control.apply({
          mode: decision.mode,
          sample_buckets: decision.sample_buckets,
          revision
        });
        const appliedTransition = this.#appliedMode !== null &&
          this.#appliedMode !== decision.mode;
        this.#revision = revision;
        this.#appliedMode = decision.mode;
        this.#pendingTransition = false;
        if (appliedTransition) this.#transitions += 1;
      }
    } catch (error) {
      this.#pendingTransition = true;
      this.#applyFailures += 1;
      throw error;
    }
    return { ...decision, revision: this.#revision };
  }

  prometheusMetrics(): string {
    const desiredMode = this.#lastDecision.mode;
    const appliedMode = this.#appliedMode;
    const observation = this.#lastObservation;
    const pending = this.#pendingTransition || appliedMode !== desiredMode ||
      this.#revision === 0;
    const observationValid = observation.collector_up &&
      observation.queue_ratio !== null &&
      observation.cpu_cores !== null &&
      observation.packets_per_second !== null &&
      observation.processing_gap_per_second !== null;
    return [
      '# HELP ivekit_kamailio_hep_mode Last confirmed applied HEP control mode.',
      '# TYPE ivekit_kamailio_hep_mode gauge',
      ...(['full', 'sampled', 'off'] as const).map(
        (candidate) => `ivekit_kamailio_hep_mode{mode="${candidate}"} ${candidate === appliedMode ? 1 : 0}`
      ),
      '# HELP ivekit_kamailio_hep_desired_mode HEP mode selected by the controller.',
      '# TYPE ivekit_kamailio_hep_desired_mode gauge',
      ...(['full', 'sampled', 'off'] as const).map(
        (candidate) => `ivekit_kamailio_hep_desired_mode{mode="${candidate}"} ${candidate === desiredMode ? 1 : 0}`
      ),
      '# HELP ivekit_kamailio_hep_control_pending Whether desired HEP state is not confirmed remotely.',
      '# TYPE ivekit_kamailio_hep_control_pending gauge',
      `ivekit_kamailio_hep_control_pending ${pending ? 1 : 0}`,
      '# HELP ivekit_kamailio_hep_collector_up Whether the last HOMER scrape succeeded.',
      '# TYPE ivekit_kamailio_hep_collector_up gauge',
      `ivekit_kamailio_hep_collector_up ${observation.collector_up ? 1 : 0}`,
      '# HELP ivekit_kamailio_hep_observation_valid Whether all rate observations are comparable.',
      '# TYPE ivekit_kamailio_hep_observation_valid gauge',
      `ivekit_kamailio_hep_observation_valid ${observationValid ? 1 : 0}`,
      '# HELP ivekit_kamailio_hep_collector_queue_ratio HOMER worker queue utilization.',
      '# TYPE ivekit_kamailio_hep_collector_queue_ratio gauge',
      `ivekit_kamailio_hep_collector_queue_ratio ${metricValue(observation.queue_ratio)}`,
      '# HELP ivekit_kamailio_hep_collector_cpu_cores HOMER process CPU cores used.',
      '# TYPE ivekit_kamailio_hep_collector_cpu_cores gauge',
      `ivekit_kamailio_hep_collector_cpu_cores ${metricValue(observation.cpu_cores)}`,
      '# HELP ivekit_kamailio_hep_collector_packets_per_second HOMER HEP receive rate.',
      '# TYPE ivekit_kamailio_hep_collector_packets_per_second gauge',
      `ivekit_kamailio_hep_collector_packets_per_second ${metricValue(observation.packets_per_second)}`,
      '# HELP ivekit_kamailio_hep_collector_processing_gap_per_second HOMER receive rate not yet matched by processing.',
      '# TYPE ivekit_kamailio_hep_collector_processing_gap_per_second gauge',
      `ivekit_kamailio_hep_collector_processing_gap_per_second ${metricValue(observation.processing_gap_per_second)}`,
      '# HELP ivekit_kamailio_hep_control_revision Last successfully applied local HEP control revision.',
      '# TYPE ivekit_kamailio_hep_control_revision gauge',
      `ivekit_kamailio_hep_control_revision ${this.#revision}`,
      '# HELP ivekit_kamailio_hep_scrape_failures_total Failed HOMER metric scrapes.',
      '# TYPE ivekit_kamailio_hep_scrape_failures_total counter',
      `ivekit_kamailio_hep_scrape_failures_total ${this.#scrapeFailures}`,
      '# HELP ivekit_kamailio_hep_control_apply_failures_total Failed Kamailio HEP control updates.',
      '# TYPE ivekit_kamailio_hep_control_apply_failures_total counter',
      `ivekit_kamailio_hep_control_apply_failures_total ${this.#applyFailures}`,
      '# HELP ivekit_kamailio_hep_transitions_total Applied HEP mode transitions.',
      '# TYPE ivekit_kamailio_hep_transitions_total counter',
      `ivekit_kamailio_hep_transitions_total ${this.#transitions}`,
      '# HELP ivekit_kamailio_hep_last_success_timestamp_seconds Last successful HOMER scrape.',
      '# TYPE ivekit_kamailio_hep_last_success_timestamp_seconds gauge',
      `ivekit_kamailio_hep_last_success_timestamp_seconds ${this.#lastSuccessTimestampSeconds}`,
      ''
    ].join('\n');
  }
}

function checkedPolicy(policy: KamailioHepHighWaterPolicy): KamailioHepHighWaterPolicy {
  const value = structuredClone(policy);
  bounded(value.sample_percent, 0.1, 100, 'HEP sample percent');
  orderedThresholds(
    value.queue_recover_ratio,
    value.queue_sample_ratio,
    value.queue_off_ratio,
    1,
    'HEP queue'
  );
  orderedThresholds(
    value.cpu_recover_cores,
    value.cpu_sample_cores,
    value.cpu_off_cores,
    1_024,
    'HEP CPU'
  );
  orderedThresholds(
    value.packets_recover_per_second,
    value.packets_sample_per_second,
    value.packets_off_per_second,
    100_000_000,
    'HEP packet rate'
  );
  orderedThresholds(
    value.processing_gap_recover_per_second,
    value.processing_gap_sample_per_second,
    value.processing_gap_off_per_second,
    100_000_000,
    'HEP processing gap'
  );
  integer(value.failure_samples_to_off, 1, 60, 'HEP failure samples');
  integer(value.recovery_samples, 1, 600, 'HEP recovery samples');
  return value;
}

function checkedObservation(observation: HomerHepObservation): HomerHepObservation {
  if (typeof observation.collector_up !== 'boolean') {
    throw new Error('HEP collector observation is invalid');
  }
  for (const [label, value] of [
    ['queue ratio', observation.queue_ratio],
    ['CPU cores', observation.cpu_cores],
    ['packet rate', observation.packets_per_second],
    ['processing gap', observation.processing_gap_per_second]
  ] as const) {
    if (value !== null && (!Number.isFinite(value) || value < 0)) {
      throw new Error(`HEP ${label} observation is invalid`);
    }
  }
  return structuredClone(observation);
}

function orderedThresholds(
  recover: number,
  sample: number,
  off: number,
  maximum: number,
  label: string
): void {
  bounded(recover, 0, maximum, `${label} recover threshold`);
  bounded(sample, 0, maximum, `${label} sample threshold`);
  bounded(off, 0, maximum, `${label} off threshold`);
  if (!(recover < sample && sample < off)) {
    throw new Error(`${label} thresholds must satisfy recover < sample < off`);
  }
}

function bounded(value: number, minimum: number, maximum: number, label: string): number {
  if (!Number.isFinite(value) || value < minimum || value > maximum) {
    throw new Error(`${label} is invalid`);
  }
  return value;
}

function integer(value: number, minimum: number, maximum: number, label: string): number {
  bounded(value, minimum, maximum, label);
  if (!Number.isInteger(value)) throw new Error(`${label} must be an integer`);
  return value;
}

function requiredMetric(
  text: string,
  name: string,
  labelName?: string,
  labelValue?: string
): number {
  for (const line of text.split('\n')) {
    if (!line.startsWith(name)) continue;
    const boundary = line[name.length];
    if (boundary !== ' ' && boundary !== '{') continue;
    if (labelName && !line.slice(name.length).startsWith('{')) continue;
    if (labelName && !new RegExp(
      `(?:^|,)${escapeRegExp(labelName)}="${escapeRegExp(labelValue || '')}"(?:,|$)`
    ).test(line.slice(line.indexOf('{') + 1, line.indexOf('}')))) continue;
    const raw = line.slice(line.lastIndexOf(' ') + 1);
    const value = Number(raw);
    if (!Number.isFinite(value) || value < 0) break;
    return value;
  }
  throw new Error(`required HOMER metric ${name} is missing or invalid`);
}

function unavailableObservation(): HomerHepObservation {
  return {
    collector_up: false,
    queue_ratio: null,
    cpu_cores: null,
    packets_per_second: null,
    processing_gap_per_second: null
  };
}

function maximumPressureMode(left: KamailioHepMode, right: KamailioHepMode): KamailioHepMode {
  return modeRank(left) >= modeRank(right) ? left : right;
}

function modeRank(mode: KamailioHepMode): number {
  return mode === 'full' ? 0 : mode === 'sampled' ? 1 : 2;
}

function atLeast(value: number | null, threshold: number): boolean {
  return value !== null && value >= threshold;
}

function atMost(value: number | null, threshold: number): boolean {
  return value !== null && value <= threshold;
}

function metricValue(value: number | null): number {
  return value === null ? 0 : value;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function checkedHomerMetricsEndpoint(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error('HOMER metrics endpoint is invalid');
  }
  if (!['http:', 'https:'].includes(url.protocol) || !url.hostname ||
      url.username || url.password || url.search || url.hash ||
      url.pathname !== '/metrics') {
    throw new Error('HOMER metrics endpoint must be credential-free /metrics');
  }
  return url;
}

async function boundedHomerMetricsResponse(response: Response): Promise<string> {
  const declared = Number(response.headers.get('content-length') || 0);
  if (declared > MAXIMUM_HOMER_METRICS_BYTES) {
    throw new Error('HOMER metrics response is too large');
  }
  if (!response.body) throw new Error('HOMER metrics response is empty');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > MAXIMUM_HOMER_METRICS_BYTES) {
        await reader.cancel();
        throw new Error('HOMER metrics response is too large');
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  if (length === 0) throw new Error('HOMER metrics response is empty');
  const body = Buffer.concat(chunks, length).toString('utf8');
  if (body.includes('\0')) throw new Error('HOMER metrics response is invalid');
  return body.endsWith('\n') ? body : `${body}\n`;
}
