import {
  resolveConveractEnv,
  resolveFabricEnv
} from '../src/config/converact-env.js';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const SIPP_BINARY_SHA256 = '8e8ecdbe923bf608c844038adfa35c8595400c4629d629f00d51539ac24cdfef';
export const ALPINE_ACCEPTANCE_IMAGE = 'alpine@sha256:d9e853e87e55526f6b2917df91a2115c36dd7c696a35be12163d44e6e2a4b6bc';

const DELIVERY_SCENARIO_DIR = fileURLToPath(new URL('../sipp/', import.meta.url));
const REPOSITORY_SCENARIO_DIR = fileURLToPath(new URL(
  '../services/converact-service/acceptance/sipp/',
  import.meta.url
));
const MAX_COMMAND_OUTPUT = 2 * 1024 * 1024;

export interface SippStatistics {
  successful_calls: number;
  failed_calls: number;
  retransmissions: number;
}

export interface RustPbxSippScenario {
  id: string;
  uac_scenario: string;
  uas_scenario?: string;
  uas_ip?: string;
  service?: string;
  transport: 'udp' | 'tcp';
  calls: number;
  timeout_seconds: number;
  auth_username?: string;
  auth_password?: string;
  uac_ip?: string;
  minimum_retransmissions?: number;
  opt_in?: boolean;
}

export interface RustPbxSippScenarioResult {
  id: string;
  status: 'passed' | 'failed';
  duration_ms: number;
  calls: number;
  transport: 'udp' | 'tcp';
  uac?: SippStatistics;
  uas?: SippStatistics;
  error_code?: string;
}

export interface RustPbxSippReport {
  schema_version: 1;
  suite: 'Converact Fabric RustPBX SIPp acceptance';
  status: 'passed' | 'failed';
  generated_at: string;
  duration_ms: number;
  tools: {
    sipp_version: '3.7.7';
    sipp_sha256: string;
    container_image: string;
  };
  target: {
    docker_network: string;
    rustpbx_ip: string;
  };
  evidence: {
    router_request_delta: number | null;
    cdr_request_delta: number | null;
  };
  scenarios: RustPbxSippScenarioResult[];
}

interface RustPbxSippOptions {
  docker: string;
  network: string;
  rustpbx_ip: string;
  uac_ip: string;
  sipp_binary: string;
  scenario_dir: string;
  result_dir: string;
  router_container: string;
  extension: string;
  extension_password: string;
  scenario_filter: string;
}

interface CommandResult {
  code: number;
  stdout: string;
  stderr: string;
  timed_out: boolean;
}

interface RouterEvidence {
  router_requests: number;
  cdr_requests: number;
}

export function selectDefaultSippScenarioDirectory(
  deliveryDirectory: string,
  repositoryDirectory: string
): string {
  const files = new Set(createRustPbxSippScenarios('scenario-directory-check')
    .flatMap((scenario) => [scenario.uac_scenario, scenario.uas_scenario].filter(Boolean)));
  const complete = (directory: string): boolean =>
    [...files].every((file) => existsSync(join(directory, file!)));

  if (complete(deliveryDirectory)) return deliveryDirectory;
  if (complete(repositoryDirectory)) return repositoryDirectory;
  throw new Error('RustPBX SIPp scenario assets are incomplete');
}

export function resolveSippScenarioDirectory(
  configuredDirectory: string | undefined,
  deliveryDirectory = DELIVERY_SCENARIO_DIR,
  repositoryDirectory = REPOSITORY_SCENARIO_DIR
): string {
  const configured = String(configuredDirectory || '').trim();
  return configured
    ? resolve(configured)
    : selectDefaultSippScenarioDirectory(deliveryDirectory, repositoryDirectory);
}

export function createRustPbxSippScenarios(
  extensionPassword: string,
  extension = '8199'
): RustPbxSippScenario[] {
  return [
    scenario('route-reject', 'inbound-reject-486-uac.xml', undefined, undefined, '+18005550999'),
    scenario('answer-udp', 'answer-bye-uac.xml', 'answer-bye-uas.xml', '172.30.44.22', '+18005550200'),
    scenario('early-cancel', 'early-cancel-uac.xml', 'early-cancel-uas.xml', '172.30.44.23', '+18005550201'),
    scenario('downstream-busy', 'expect-486-uac.xml', 'busy-486-uas.xml', '172.30.44.24', '+18005550202'),
    scenario('downstream-unavailable', 'expect-503-uac.xml', 'unavailable-503-uas.xml', '172.30.44.25', '+18005550203'),
    {
      ...scenario('no-answer-timeout', 'expect-487-timeout-uac.xml', 'no-answer-uas.xml', '172.30.44.26', '+18005550204'),
      timeout_seconds: 45
    },
    scenario('answer-tcp', 'answer-bye-uac.xml', 'answer-bye-uas.xml', '172.30.44.27', '+18005550205', 'tcp'),
    scenario('answer-tcp-reconnect', 'answer-bye-uac.xml', 'answer-bye-uas.xml', '172.30.44.27', '+18005550205', 'tcp'),
    {
      ...scenario('udp-retransmission', 'expect-486-uac.xml', 'delayed-busy-486-uas.xml', '172.30.44.28', '+18005550206'),
      minimum_retransmissions: 1
    },
    {
      ...scenario('concurrent-udp-10', 'answer-bye-uac.xml', 'answer-bye-uas.xml', '172.30.44.22', '+18005550200'),
      calls: 10,
      timeout_seconds: 30
    },
    {
      id: 'register-digest',
      uac_scenario: 'register-digest-uac.xml',
      service: extension,
      transport: 'udp',
      calls: 1,
      timeout_seconds: 15,
      auth_username: extension,
      auth_password: extensionPassword,
      uac_ip: '172.30.44.21'
    },
    {
      id: 'register-invalid-password',
      uac_scenario: 'register-invalid-digest-uac.xml',
      service: extension,
      transport: 'udp',
      calls: 1,
      timeout_seconds: 15,
      auth_username: extension,
      auth_password: 'invalid-acceptance-password',
      uac_ip: '172.30.44.29'
    },
    {
      ...scenario(
        'long-call-2h',
        'long-call-2h-uac.xml',
        'long-call-2h-uas.xml',
        '172.30.44.22',
        '+18005550207'
      ),
      timeout_seconds: 7_260,
      opt_in: true
    }
  ];
}

export function selectRustPbxSippScenarios(
  scenarios: RustPbxSippScenario[],
  rawFilter: string
): RustPbxSippScenario[] {
  const requested = new Set(rawFilter.split(',').map((value) => value.trim()).filter(Boolean));
  if (!requested.size) return scenarios.filter((scenario) => !scenario.opt_in);
  const known = new Set(scenarios.map((scenario) => scenario.id));
  const unknown = [...requested].filter((id) => !known.has(id));
  if (unknown.length) throw new Error(`unknown RustPBX SIPp scenarios: ${unknown.join(', ')}`);
  if (requested.has('answer-tcp-reconnect')) requested.add('answer-tcp');
  return scenarios.filter((scenario) => requested.has(scenario.id));
}

export function parseSippStatistics(csv: string): SippStatistics {
  const lines = csv.trim().split(/\r?\n/).filter(Boolean);
  if (lines.length < 2) throw new Error('SIPp statistics are missing rows');
  const headers = lines[0]!.split(';');
  const values = lines[lines.length - 1]!.split(';');
  const value = (name: string): number => {
    const index = headers.indexOf(name);
    if (index < 0) throw new Error(`SIPp statistics are missing ${name}`);
    const parsed = Number(values[index]);
    if (!Number.isInteger(parsed) || parsed < 0) {
      throw new Error(`SIPp statistics contain invalid ${name}`);
    }
    return parsed;
  };
  return {
    successful_calls: value('SuccessfulCall(C)'),
    failed_calls: value('FailedCall(C)'),
    retransmissions: value('Retransmissions(C)')
  };
}

export function countIncomingInviteRetransmissions(messages: string, calls: number): number {
  const invites = messages.match(/^INVITE sip:[^\r\n]+ SIP\/2\.0\r?$/gmi)?.length || 0;
  return Math.max(0, invites - calls);
}

export function renderSippCallIdTemplate(
  scenarioId: string,
  runNonce: string,
  localIp: string
): string {
  return `${scenarioId}-${runNonce}-%u@${localIp}`;
}

export function renderRustPbxSippJUnit(input: Pick<
  RustPbxSippReport,
  'status' | 'generated_at' | 'duration_ms' | 'scenarios'
>): string {
  const failures = input.scenarios.filter((scenario) => scenario.status === 'failed').length;
  const cases = input.scenarios.map((scenario) => {
    const failure = scenario.status === 'failed'
      ? `\n    <failure message="${xml(scenario.error_code || 'acceptance_failed')}" />`
      : '';
    return `  <testcase classname="converact.rustpbx.sipp" name="${xml(scenario.id)}" time="${(scenario.duration_ms / 1000).toFixed(3)}">${failure}\n  </testcase>`;
  }).join('\n');
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<testsuite name="Converact Fabric RustPBX SIPp acceptance" tests="${input.scenarios.length}" failures="${failures}" time="${(input.duration_ms / 1000).toFixed(3)}" timestamp="${xml(input.generated_at)}">`,
    cases,
    '</testsuite>',
    ''
  ].join('\n');
}

export async function runRustPbxSippAcceptance(
  env: NodeJS.ProcessEnv = process.env
): Promise<RustPbxSippReport> {
  const options = optionsFromEnv(env);
  assertSippBinary(options.sipp_binary);
  assertScenarioAssets(options.scenario_dir, createRustPbxSippScenarios(options.extension_password, options.extension));
  mkdirSync(options.result_dir, { recursive: true });
  await requireCommand(options.docker, ['network', 'inspect', options.network], 10_000);
  await requireCommand(options.docker, ['image', 'inspect', ALPINE_ACCEPTANCE_IMAGE], 10_000);

  const startedAt = Date.now();
  const before = options.router_container
    ? await readRouterEvidence(options).catch(() => null)
    : null;
  const scenarios = selectRustPbxSippScenarios(
    createRustPbxSippScenarios(options.extension_password, options.extension),
    options.scenario_filter
  );
  const results: RustPbxSippScenarioResult[] = [];
  for (const entry of scenarios) results.push(await runScenario(options, entry));
  const after = options.router_container
    ? await waitForRouterEvidence(options, before, expectedCallCount(scenarios)).catch(() => null)
    : null;

  const report: RustPbxSippReport = {
    schema_version: 1,
    suite: 'Converact Fabric RustPBX SIPp acceptance',
    status: results.every((result) => result.status === 'passed') ? 'passed' : 'failed',
    generated_at: new Date().toISOString(),
    duration_ms: Date.now() - startedAt,
    tools: {
      sipp_version: '3.7.7',
      sipp_sha256: SIPP_BINARY_SHA256,
      container_image: ALPINE_ACCEPTANCE_IMAGE
    },
    target: { docker_network: options.network, rustpbx_ip: options.rustpbx_ip },
    evidence: {
      router_request_delta: evidenceDelta(before, after, 'router_requests'),
      cdr_request_delta: evidenceDelta(before, after, 'cdr_requests')
    },
    scenarios: results
  };
  const serialized = `${JSON.stringify(report, null, 2)}\n`;
  if (serialized.includes(options.extension_password)) {
    throw new Error('refusing to write a SIPp report containing the extension password');
  }
  writeFileSync(join(options.result_dir, 'report.json'), serialized, { mode: 0o600 });
  writeFileSync(
    join(options.result_dir, 'junit.xml'),
    renderRustPbxSippJUnit(report),
    { mode: 0o600 }
  );
  return report;
}

async function runScenario(
  options: RustPbxSippOptions,
  entry: RustPbxSippScenario
): Promise<RustPbxSippScenarioResult> {
  const startedAt = Date.now();
  const runNonce = `${startedAt}-${process.pid}`;
  const suffix = `${runNonce}-${entry.id}`;
  const uasName = `converact-sipp-uas-${suffix}`;
  const uacName = `converact-sipp-uac-${suffix}`;
  const uacStats = `${entry.id}-uac.csv`;
  const uasStats = `${entry.id}-uas.csv`;
  const uacMessages = `${entry.id}-uac-messages.log`;
  const uasMessages = `${entry.id}-uas-messages.log`;
  for (const file of [
    uacStats,
    uasStats,
    uacMessages,
    uasMessages,
    `${entry.id}-uac-errors.log`,
    `${entry.id}-uas-errors.log`
  ]) rmSync(join(options.result_dir, file), { force: true });
  try {
    if (entry.uas_scenario && entry.uas_ip) {
      const started = await command(options.docker, dockerRunArgs({
        options,
        entry,
        role: 'uas',
        name: uasName,
        statsFile: uasStats,
        detached: true,
        runNonce
      }), 15_000);
      if (started.code !== 0) return failed(entry, startedAt, 'uas_start_failed');
      await sleep(entry.transport === 'tcp' ? 1000 : 300);
      const running = await command(
        options.docker,
        ['inspect', '--format={{.State.Running}}', uasName],
        10_000
      );
      if (running.code !== 0 || running.stdout.trim() !== 'true') {
        return failed(entry, startedAt, 'uas_start_failed');
      }
    }

    const uac = await command(options.docker, dockerRunArgs({
      options,
      entry,
      role: 'uac',
      name: uacName,
      statsFile: uacStats,
      detached: false,
      runNonce
    }), (entry.timeout_seconds + 10) * 1000);
    if (uac.code !== 0 || uac.timed_out) return failed(entry, startedAt, 'uac_failed');

    if (entry.uas_scenario) {
      const waited = await command(options.docker, ['wait', uasName], (entry.timeout_seconds + 5) * 1000);
      if (waited.code !== 0 || Number(waited.stdout.trim()) !== 0) {
        return failed(entry, startedAt, 'uas_failed');
      }
    }

    const uacStatistics = parseSippStatistics(readFileSync(join(options.result_dir, uacStats), 'utf8'));
    const uasStatistics = entry.uas_scenario
      ? parseSippStatistics(readFileSync(join(options.result_dir, uasStats), 'utf8'))
      : undefined;
    if (uasStatistics && entry.minimum_retransmissions) {
      uasStatistics.retransmissions = Math.max(
        uasStatistics.retransmissions,
        countIncomingInviteRetransmissions(
          readFileSync(join(options.result_dir, uasMessages), 'utf8'),
          entry.calls
        )
      );
    }
    if (uacStatistics.successful_calls !== entry.calls || uacStatistics.failed_calls !== 0
      || (uasStatistics && (uasStatistics.successful_calls !== entry.calls || uasStatistics.failed_calls !== 0))) {
      return failed(entry, startedAt, 'call_count_mismatch');
    }
    if (entry.minimum_retransmissions
      && (uasStatistics?.retransmissions || 0) < entry.minimum_retransmissions) {
      return failed(entry, startedAt, 'retransmission_not_observed');
    }
    return {
      id: entry.id,
      status: 'passed',
      duration_ms: Date.now() - startedAt,
      calls: entry.calls,
      transport: entry.transport,
      uac: uacStatistics,
      ...(uasStatistics ? { uas: uasStatistics } : {})
    };
  } catch {
    return failed(entry, startedAt, 'acceptance_runtime_error');
  } finally {
    await cleanupContainer(options.docker, uacName);
    await cleanupContainer(options.docker, uasName);
  }
}

function dockerRunArgs(input: {
  options: RustPbxSippOptions;
  entry: RustPbxSippScenario;
  role: 'uac' | 'uas';
  name: string;
  statsFile: string;
  detached: boolean;
  runNonce: string;
}): string[] {
  const { options, entry, role } = input;
  const localIp = role === 'uac' ? entry.uac_ip || options.uac_ip : entry.uas_ip!;
  const scenarioFile = role === 'uac' ? entry.uac_scenario : entry.uas_scenario!;
  const args = [
    'run',
    ...(input.detached ? ['-d'] : []),
    '--name', input.name,
    '--network', options.network,
    '--ip', localIp,
    '-v', `${options.sipp_binary}:/acceptance/sipp:ro`,
    '-v', `${join(options.scenario_dir, scenarioFile)}:/acceptance/scenario.xml:ro`,
    '-v', `${options.result_dir}:/results`,
    ALPINE_ACCEPTANCE_IMAGE,
    '/acceptance/sipp'
  ];
  if (role === 'uac') args.push(`${options.rustpbx_ip}:5060`);
  args.push(
    '-sf', '/acceptance/scenario.xml',
    '-i', localIp,
    '-p', '5060',
    '-t', entry.transport === 'tcp' ? role === 'uas' ? 'tn' : 't1' : 'u1',
    '-m', String(entry.calls),
    '-timeout', String(entry.timeout_seconds),
    '-trace_stat',
    '-stf', `/results/${input.statsFile}`,
    '-trace_err',
    '-error_file', `/results/${entry.id}-${role}-errors.log`,
    '-trace_msg',
    '-message_file', `/results/${entry.id}-${role}-messages.log`
  );
  if (entry.transport === 'tcp' && role === 'uas') args.push('-max_socket', '500');
  if (role === 'uac') {
    args.push('-cid_str', renderSippCallIdTemplate(entry.id, input.runNonce, localIp));
    if (entry.service) args.push('-s', entry.service);
    if (entry.calls > 1) args.push('-r', String(entry.calls), '-rp', '1000');
    if (entry.auth_username) args.push('-au', entry.auth_username);
    if (entry.auth_password) args.push('-ap', entry.auth_password);
  }
  return args;
}

function optionsFromEnv(env: NodeJS.ProcessEnv): RustPbxSippOptions {
  const binary = required(env, 'CONVERACT_FABRIC_SIPP_BINARY');
  const network = boundedName(
    required(env, 'CONVERACT_FABRIC_RUSTPBX_ACCEPTANCE_NETWORK'),
    'Docker network'
  );
  const extensionPassword = required(
    env,
    'CONVERACT_FABRIC_RUSTPBX_EXTENSION_PASSWORD'
  );
  if (extensionPassword.length < 8 || extensionPassword.length > 256) {
    throw new Error('CONVERACT_FABRIC_RUSTPBX_EXTENSION_PASSWORD must contain 8 to 256 characters');
  }
  return {
    docker: resolveFabricEnv(env, 'DOCKER_COMMAND') || 'docker',
    network,
    rustpbx_ip: ipv4(
      resolveFabricEnv(env, 'RUSTPBX_ACCEPTANCE_IP') || '172.30.44.10'
    ),
    uac_ip: ipv4(
      resolveFabricEnv(env, 'RUSTPBX_ACCEPTANCE_UAC_IP') || '172.30.44.20'
    ),
    sipp_binary: resolve(binary),
    scenario_dir: resolveSippScenarioDirectory(
      resolveFabricEnv(env, 'RUSTPBX_SIPP_SCENARIO_DIR')
    ),
    result_dir: resolve(
      resolveFabricEnv(env, 'RUSTPBX_SIPP_RESULT_DIR') ||
      `.tmp/converact-rustpbx-sipp-${Date.now()}`
    ),
    router_container: String(
      resolveFabricEnv(env, 'RUSTPBX_ROUTER_CONTAINER') || ''
    ).trim(),
    extension: boundedDigits(
      resolveFabricEnv(env, 'RUSTPBX_EXTENSION') || '8199'
    ),
    extension_password: extensionPassword,
    scenario_filter: String(
      resolveFabricEnv(env, 'RUSTPBX_ACCEPTANCE_SCENARIOS') || ''
    ).trim()
  };
}

function assertSippBinary(path: string): void {
  const digest = createHash('sha256').update(readFileSync(path)).digest('hex');
  if (digest !== SIPP_BINARY_SHA256) throw new Error('SIPp binary checksum mismatch');
}

function assertScenarioAssets(directory: string, scenarios: RustPbxSippScenario[]): void {
  const files = new Set(scenarios.flatMap((entry) => [entry.uac_scenario, entry.uas_scenario].filter(Boolean)));
  for (const file of files) readFileSync(join(directory, file!), 'utf8');
}

async function readRouterEvidence(options: RustPbxSippOptions): Promise<RouterEvidence> {
  const result = await requireCommand(
    options.docker,
    createRouterEvidenceCommand(options.router_container),
    10_000
  );
  const payload = JSON.parse(result.stdout) as RouterEvidence;
  return {
    router_requests: nonNegative(payload.router_requests),
    cdr_requests: nonNegative(payload.cdr_requests)
  };
}

export function createRouterEvidenceCommand(routerContainer: string): string[] {
  const container = boundedName(routerContainer, 'Router container');
  const program = [
    "fetch('http://127.0.0.1:8081/evidence',{headers:{'X-PBX-Key':process.env.RUSTPBX_WEBHOOK_TOKEN||''}})",
    ".then(async response=>{if(!response.ok)throw new Error(String(response.status));process.stdout.write(await response.text())})",
    ".catch(error=>{console.error(error);process.exit(1)})"
  ].join('');
  return ['exec', container, 'node', '-e', program];
}

async function waitForRouterEvidence(
  options: RustPbxSippOptions,
  before: RouterEvidence | null,
  expectedCalls: number
): Promise<RouterEvidence> {
  let current = await readRouterEvidence(options);
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const routerDelta = evidenceDelta(before, current, 'router_requests') || 0;
    const cdrDelta = evidenceDelta(before, current, 'cdr_requests') || 0;
    if (routerDelta >= expectedCalls && cdrDelta >= expectedCalls) return current;
    await sleep(500);
    current = await readRouterEvidence(options);
  }
  throw new Error('Router/CDR evidence did not reach the expected call count');
}

function expectedCallCount(scenarios: RustPbxSippScenario[]): number {
  return scenarios
    .filter((entry) => entry.service?.startsWith('+180055502') || entry.id === 'route-reject')
    .reduce((total, entry) => total + entry.calls, 0);
}

function evidenceDelta(
  before: RouterEvidence | null,
  after: RouterEvidence | null,
  key: keyof RouterEvidence
): number | null {
  return before && after ? Math.max(0, after[key] - before[key]) : null;
}

async function cleanupContainer(docker: string, name: string): Promise<void> {
  await command(docker, ['rm', '-f', name], 10_000).catch(() => undefined);
}

async function requireCommand(executable: string, args: string[], timeoutMs: number): Promise<CommandResult> {
  const result = await command(executable, args, timeoutMs);
  if (result.code !== 0 || result.timed_out) throw new Error('acceptance prerequisite command failed');
  return result;
}

function command(executable: string, args: string[], timeoutMs: number): Promise<CommandResult> {
  return new Promise((resolveCommand) => {
    const child = spawn(executable, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const append = (target: 'stdout' | 'stderr', chunk: Buffer): void => {
      const value = target === 'stdout' ? stdout : stderr;
      const next = `${value}${chunk.toString('utf8')}`;
      if (target === 'stdout') stdout = next.slice(-MAX_COMMAND_OUTPUT);
      else stderr = next.slice(-MAX_COMMAND_OUTPUT);
    };
    child.stdout.on('data', (chunk: Buffer) => append('stdout', chunk));
    child.stderr.on('data', (chunk: Buffer) => append('stderr', chunk));
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);
    child.on('error', () => {
      clearTimeout(timer);
      resolveCommand({ code: -1, stdout, stderr, timed_out: timedOut });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolveCommand({ code: code ?? -1, stdout, stderr, timed_out: timedOut });
    });
  });
}

function scenario(
  id: string,
  uac: string,
  uas: string | undefined,
  uasIp: string | undefined,
  service: string,
  transport: 'udp' | 'tcp' = 'udp'
): RustPbxSippScenario {
  return {
    id,
    uac_scenario: uac,
    ...(uas ? { uas_scenario: uas } : {}),
    ...(uasIp ? { uas_ip: uasIp } : {}),
    service,
    transport,
    calls: 1,
    timeout_seconds: 15
  };
}

function failed(
  entry: RustPbxSippScenario,
  startedAt: number,
  errorCode: string
): RustPbxSippScenarioResult {
  return {
    id: entry.id,
    status: 'failed',
    duration_ms: Date.now() - startedAt,
    calls: entry.calls,
    transport: entry.transport,
    error_code: errorCode
  };
}

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = String(resolveConveractEnv(env, name) || '').trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function boundedName(value: string, label: string): string {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/.test(value)) throw new Error(`${label} is invalid`);
  return value;
}

function boundedDigits(value: string): string {
  if (!/^\d{2,16}$/.test(value)) {
    throw new Error('CONVERACT_FABRIC_RUSTPBX_EXTENSION is invalid');
  }
  return value;
}

function ipv4(value: string): string {
  const parts = value.split('.');
  if (parts.length !== 4 || parts.some((part) => !/^\d{1,3}$/.test(part) || Number(part) > 255)) {
    throw new Error('RustPBX SIPp acceptance IP address is invalid');
  }
  return value;
}

function nonNegative(value: unknown): number {
  if (!Number.isInteger(value) || Number(value) < 0) throw new Error('invalid Router evidence');
  return Number(value);
}

function xml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;'
  })[character]!);
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, milliseconds));
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : '';
if (invokedPath === fileURLToPath(import.meta.url)) {
  void runRustPbxSippAcceptance().then((report) => {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    if (report.status !== 'passed') process.exitCode = 1;
  }).catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : 'RustPBX SIPp acceptance failed'}\n`);
    process.exitCode = 1;
  });
}
