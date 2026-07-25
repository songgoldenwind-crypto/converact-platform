import { spawn } from 'node:child_process';

export interface NetworkImpairmentLease {
  run_id: string;
  shard_id: string;
  worker_id: string;
  lease_epoch: string;
}

export interface NetworkImpairmentProfile {
  id: string;
  round_trip_time_ms: number;
  jitter_ms: number;
  packet_loss_ratio: number;
  downstream_kbps: number;
  upstream_kbps: number;
  blackout_ms: number;
}

export interface NetworkImpairmentCommand {
  operation: 'apply' | 'blackout' | 'restore';
  executable: '/sbin/ip' | '/sbin/tc';
  args: string[];
  ignore_failure?: boolean;
}

export interface NetworkImpairmentPlan {
  schema_version: '1.0.0';
  lease: NetworkImpairmentLease;
  interface_name: string;
  ifb_interface_name: string;
  profile: NetworkImpairmentProfile;
  one_way_delay_ms: number;
  one_way_jitter_ms: number;
  apply: NetworkImpairmentCommand[];
  blackout: NetworkImpairmentCommand[];
  restore: NetworkImpairmentCommand[];
}

export interface NetworkImpairmentReceipt {
  schema_version: '1.0.0' | '1.1.0';
  lease: NetworkImpairmentLease;
  interface_name?: string;
  ifb_interface_name?: string;
  profile: NetworkImpairmentProfile;
  applied_at: string;
  command_count: number;
}

export interface NetworkImpairmentReleaseReceipt {
  schema_version: '1.0.0';
  lease: NetworkImpairmentLease;
  released: boolean;
  released_at: string;
}

export type NetworkImpairmentCommandExecutor = (
  command: NetworkImpairmentCommand
) => Promise<{ code: number; stderr: string }>;

export function executeNetworkImpairmentCommand(
  command: NetworkImpairmentCommand
): Promise<{ code: number; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(command.executable, command.args, {
      stdio: ['ignore', 'ignore', 'pipe']
    });
    let stderr = '';
    child.stderr.on('data', (chunk: Buffer) => {
      stderr = `${stderr}${chunk.toString('utf8')}`.slice(-64 * 1024);
    });
    child.on('error', (error) => resolve({ code: -1, stderr: error.message }));
    child.on('close', (code) => resolve({ code: code ?? -1, stderr }));
  });
}

export function buildNetworkImpairmentRestoreCommands(input: {
  interface_name: string;
  ifb_interface_name: string;
}): NetworkImpairmentCommand[] {
  networkInterface(input.interface_name, 'network interface');
  networkInterface(input.ifb_interface_name, 'IFB interface');
  if (input.interface_name === input.ifb_interface_name) {
    throw new Error('network interface and IFB interface must differ');
  }
  return restoreCommands(input.interface_name, input.ifb_interface_name);
}

export function buildNetworkImpairmentPlan(input: {
  lease: NetworkImpairmentLease;
  interface_name: string;
  ifb_interface_name: string;
  profile: NetworkImpairmentProfile;
}): NetworkImpairmentPlan {
  validateLease(input.lease);
  networkInterface(input.interface_name, 'network interface');
  networkInterface(input.ifb_interface_name, 'IFB interface');
  if (input.interface_name === input.ifb_interface_name) {
    throw new Error('network interface and IFB interface must differ');
  }
  validateProfile(input.profile);
  const oneWayDelay = input.profile.round_trip_time_ms / 2;
  const oneWayJitter = input.profile.jitter_ms / 2;
  const restore = restoreCommands(input.interface_name, input.ifb_interface_name);
  return {
    schema_version: '1.0.0',
    lease: structuredClone(input.lease),
    interface_name: input.interface_name,
    ifb_interface_name: input.ifb_interface_name,
    profile: structuredClone(input.profile),
    one_way_delay_ms: oneWayDelay,
    one_way_jitter_ms: oneWayJitter,
    apply: [
      command('apply', '/sbin/ip', ['link', 'add', input.ifb_interface_name, 'type', 'ifb']),
      command('apply', '/sbin/ip', ['link', 'set', 'dev', input.ifb_interface_name, 'up']),
      command('apply', '/sbin/tc', ['qdisc', 'replace', 'dev', input.interface_name, 'handle', 'ffff:', 'ingress']),
      command('apply', '/sbin/tc', [
        'filter', 'replace', 'dev', input.interface_name, 'parent', 'ffff:', 'protocol', 'all',
        'u32', 'match', 'u32', '0', '0', 'action', 'mirred', 'egress', 'redirect', 'dev',
        input.ifb_interface_name
      ]),
      netem('apply', input.interface_name, oneWayDelay, oneWayJitter,
        input.profile.packet_loss_ratio, input.profile.upstream_kbps),
      netem('apply', input.ifb_interface_name, oneWayDelay, oneWayJitter,
        input.profile.packet_loss_ratio, input.profile.downstream_kbps)
    ],
    blackout: [
      blackout(input.interface_name),
      blackout(input.ifb_interface_name)
    ],
    restore
  };
}

export class FencedNetworkImpairmentController {
  readonly #execute: NetworkImpairmentCommandExecutor;
  readonly #wait: (milliseconds: number) => Promise<void>;
  readonly #now: () => string;
  #active: { plan: NetworkImpairmentPlan; receipt: NetworkImpairmentReceipt } | null = null;

  constructor(input: {
    execute: NetworkImpairmentCommandExecutor;
    wait?: (milliseconds: number) => Promise<void>;
    now?: () => string;
  }) {
    this.#execute = input.execute;
    this.#wait = input.wait || delay;
    this.#now = input.now || (() => new Date().toISOString());
  }

  async apply(plan: NetworkImpairmentPlan): Promise<NetworkImpairmentReceipt> {
    const validated = buildNetworkImpairmentPlan(plan);
    if (this.#active) {
      assertSameAssignment(this.#active.plan.lease, validated.lease);
      const activeEpoch = BigInt(this.#active.plan.lease.lease_epoch);
      const incomingEpoch = BigInt(validated.lease.lease_epoch);
      if (incomingEpoch <= activeEpoch) {
        throw new Error('network impairment lease is stale or already active');
      }
      await this.#executeAll(this.#active.plan.restore);
      this.#active = null;
    }
    try {
      await this.#executeAll(validated.apply);
    } catch (error) {
      await this.#executeAll(validated.restore);
      throw error;
    }
    const receipt: NetworkImpairmentReceipt = {
      schema_version: '1.1.0',
      lease: structuredClone(validated.lease),
      interface_name: validated.interface_name,
      ifb_interface_name: validated.ifb_interface_name,
      profile: structuredClone(validated.profile),
      applied_at: this.#now(),
      command_count: validated.apply.length
    };
    this.#active = { plan: validated, receipt };
    return structuredClone(receipt);
  }

  async runBlackout(lease: NetworkImpairmentLease): Promise<{
    lease: NetworkImpairmentLease;
    blackout_ms: number;
    restored: true;
  }> {
    const active = this.#requireActive(lease);
    if (active.plan.profile.blackout_ms <= 0) {
      throw new Error('active network impairment profile has no blackout');
    }
    await this.#executeAll(active.plan.blackout);
    try {
      await this.#wait(active.plan.profile.blackout_ms);
    } finally {
      await this.#executeAll(active.plan.apply.slice(4));
    }
    return {
      lease: structuredClone(active.plan.lease),
      blackout_ms: active.plan.profile.blackout_ms,
      restored: true
    };
  }

  async release(lease: NetworkImpairmentLease): Promise<{
    schema_version: '1.0.0';
    lease: NetworkImpairmentLease;
    released: boolean;
    released_at: string;
  }> {
    validateLease(lease);
    if (!this.#active) {
      return {
        schema_version: '1.0.0',
        lease: structuredClone(lease),
        released: false,
        released_at: this.#now()
      };
    }
    const active = this.#requireActive(lease);
    await this.#executeAll(active.plan.restore);
    this.#active = null;
    return {
      schema_version: '1.0.0',
      lease: structuredClone(lease),
      released: true,
      released_at: this.#now()
    };
  }

  activeLease(): NetworkImpairmentLease | null {
    return this.#active ? structuredClone(this.#active.plan.lease) : null;
  }

  #requireActive(lease: NetworkImpairmentLease): { plan: NetworkImpairmentPlan; receipt: NetworkImpairmentReceipt } {
    validateLease(lease);
    if (!this.#active) throw new Error('network impairment has no active lease');
    if (!sameLease(this.#active.plan.lease, lease)) {
      throw new Error('network impairment lease is stale or belongs to another assignment');
    }
    return this.#active;
  }

  async #executeAll(commands: NetworkImpairmentCommand[]): Promise<void> {
    for (const item of commands) {
      const result = await this.#execute(item);
      if (result.code !== 0 && !item.ignore_failure) {
        throw new Error(result.stderr || `${item.executable} exited with ${result.code}`);
      }
    }
  }
}

function netem(
  operation: 'apply',
  device: string,
  delayMs: number,
  jitterMs: number,
  lossRatio: number,
  rateKbps: number
): NetworkImpairmentCommand {
  const args = ['qdisc', 'replace', 'dev', device, 'root', 'handle', '1:', 'netem'];
  if (delayMs > 0) {
    args.push('delay', milliseconds(delayMs));
    if (jitterMs > 0) args.push(milliseconds(jitterMs), 'distribution', 'normal');
  }
  args.push('loss', percentage(lossRatio), 'rate', `${rateKbps}kbit`, 'limit', '100000');
  return command(operation, '/sbin/tc', args);
}

function blackout(device: string): NetworkImpairmentCommand {
  return command('blackout', '/sbin/tc', [
    'qdisc', 'replace', 'dev', device, 'root', 'handle', '1:', 'netem',
    'loss', '100%', 'limit', '100000'
  ]);
}

function restoreCommands(network: string, ifb: string): NetworkImpairmentCommand[] {
  return [
    command('restore', '/sbin/tc', ['qdisc', 'del', 'dev', network, 'root'], true),
    command('restore', '/sbin/tc', ['qdisc', 'del', 'dev', network, 'ingress'], true),
    command('restore', '/sbin/tc', ['qdisc', 'del', 'dev', ifb, 'root'], true),
    command('restore', '/sbin/ip', ['link', 'del', ifb], true)
  ];
}

function command(
  operation: NetworkImpairmentCommand['operation'],
  executable: NetworkImpairmentCommand['executable'],
  args: string[],
  ignoreFailure = false
): NetworkImpairmentCommand {
  return { operation, executable, args, ...(ignoreFailure ? { ignore_failure: true } : {}) };
}

function validateLease(lease: NetworkImpairmentLease): void {
  if (!lease || typeof lease !== 'object') throw new Error('invalid network impairment lease');
  safeId(lease.run_id, 'run ID');
  safeShard(lease.shard_id);
  safeId(lease.worker_id, 'worker ID');
  if (typeof lease.lease_epoch !== 'string' ||
      !/^[1-9][0-9]{0,18}$/.test(lease.lease_epoch)) {
    throw new Error('invalid network impairment lease epoch');
  }
}

function validateProfile(profile: NetworkImpairmentProfile): void {
  if (!profile || typeof profile !== 'object') throw new Error('invalid network impairment profile');
  safeId(profile.id, 'profile ID');
  for (const [field, value] of Object.entries({
    round_trip_time_ms: profile.round_trip_time_ms,
    jitter_ms: profile.jitter_ms,
    blackout_ms: profile.blackout_ms
  })) {
    if (!Number.isFinite(value) || value < 0) throw new Error(`invalid network impairment ${field}`);
  }
  if (!Number.isFinite(profile.packet_loss_ratio) ||
      profile.packet_loss_ratio < 0 || profile.packet_loss_ratio > 1) {
    throw new Error('invalid network impairment packet loss ratio');
  }
  for (const [field, value] of Object.entries({
    downstream_kbps: profile.downstream_kbps,
    upstream_kbps: profile.upstream_kbps
  })) {
    if (!Number.isInteger(value) || value <= 0) throw new Error(`invalid network impairment ${field}`);
  }
}

function assertSameAssignment(active: NetworkImpairmentLease, incoming: NetworkImpairmentLease): void {
  if (active.run_id !== incoming.run_id || active.shard_id !== incoming.shard_id ||
      active.worker_id !== incoming.worker_id) {
    throw new Error('network impairment is active for another assignment');
  }
}

function sameLease(left: NetworkImpairmentLease, right: NetworkImpairmentLease): boolean {
  return left.run_id === right.run_id && left.shard_id === right.shard_id &&
    left.worker_id === right.worker_id && left.lease_epoch === right.lease_epoch;
}

function networkInterface(value: string, label: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,14}$/.test(value)) throw new Error(`invalid ${label}`);
}

function safeId(value: string, label: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._@:-]{2,255}$/.test(value)) throw new Error(`invalid ${label}`);
}

function safeShard(value: string): void {
  if (!value || value.length > 512 || !/^[A-Za-z0-9][A-Za-z0-9._@:/-]+$/.test(value)) {
    throw new Error('invalid shard ID');
  }
}

function milliseconds(value: number): string {
  return `${Number(value.toFixed(3))}ms`;
}

function percentage(ratio: number): string {
  return `${Number((ratio * 100).toFixed(6))}%`;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
