import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const ACTIONS = new Set([
  'add',
  'defer',
  'keep',
  'poc',
  'reject',
  'replace',
  'upgrade'
]);

const REQUIRED_DECISIONS: Readonly<Record<string, { action: string; targetIncludes: string }>> = {
  'cloudnative-pg': { action: 'add', targetIncludes: 'CloudNativePG' },
  'homer': { action: 'add', targetIncludes: 'HOMER 11' },
  'livekit-ingress': { action: 'add', targetIncludes: 'v1.5.0' },
  'livekit-server': { action: 'upgrade', targetIncludes: 'v1.13.4' },
  'minio': { action: 'replace', targetIncludes: 'SeaweedFS' },
  'nats-js-client': { action: 'replace', targetIncludes: '@nats-io/transport-node' },
  'node-runtime': { action: 'upgrade', targetIncludes: '24.x LTS' },
  'opentelemetry': { action: 'add', targetIncludes: 'OpenTelemetry' },
  'realtime-voice-pipeline': { action: 'keep', targetIncludes: 'LiveKit Agents' },
  'redis-to-valkey': { action: 'replace', targetIncludes: 'Valkey 9.1.0' },
  'rtpengine': {
    action: 'add',
    targetIncludes: '506cfa74386a5373e40fca139a932917f22f0524'
  },
  'rustdesk-server': { action: 'upgrade', targetIncludes: '1.1.16' },
  'seaweedfs': { action: 'add', targetIncludes: 'SeaweedFS 4.40' },
  'siphon-sip': { action: 'poc', targetIncludes: 'v1.4.1' },
  'sip-exporter': { action: 'add', targetIncludes: '1.4.0' },
  'ccs-callreport': { action: 'reject', targetIncludes: 'no code import' },
  'victoriametrics': { action: 'add', targetIncludes: 'VictoriaMetrics' }
};

export interface TechnologyDecision {
  id: string;
  layer: string;
  capability: string;
  current: string;
  target: string;
  action: string;
  rollout: string;
  hot_path: boolean;
  rationale: string;
  gates: string[];
}

export interface TechnologyBaseline {
  schema_version: string;
  baseline_id: string;
  audited_at: string;
  scope: string;
  status: string;
  principles: string[];
  decisions: TechnologyDecision[];
}

export interface TechnologyBaselineVerification {
  baseline_id: string;
  audited_at: string;
  decision_count: number;
  action_counts: Record<string, number>;
  node_runtime: string;
  nodemailer: string;
  homer_hep_connector: boolean;
  python_dependency_lock: boolean;
  realtime_voice_pipeline: boolean;
  sip_exporter_profile: boolean;
}

export function validateTechnologyBaseline(value: unknown): TechnologyBaseline {
  if (!isRecord(value)) throw new Error('technology baseline must be an object');
  if (value.schema_version !== '1.0.0') throw new Error('unsupported technology baseline schema');
  assertNonEmptyString(value.baseline_id, 'baseline_id');
  assertNonEmptyString(value.scope, 'scope');
  assertNonEmptyString(value.status, 'status');
  if (typeof value.audited_at !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value.audited_at)) {
    throw new Error('audited_at must use YYYY-MM-DD');
  }
  if (!Array.isArray(value.principles) || value.principles.length < 3) {
    throw new Error('technology baseline must declare at least three principles');
  }
  value.principles.forEach((item, index) => assertNonEmptyString(item, `principles[${index}]`));
  if (!Array.isArray(value.decisions) || value.decisions.length === 0) {
    throw new Error('technology baseline decisions are required');
  }

  const decisions = value.decisions.map((item, index) => validateDecision(item, index));
  const ids = new Set<string>();
  for (const decision of decisions) {
    if (ids.has(decision.id)) throw new Error(`duplicate technology decision: ${decision.id}`);
    ids.add(decision.id);
  }
  for (const [id, expected] of Object.entries(REQUIRED_DECISIONS)) {
    const decision = decisions.find((candidate) => candidate.id === id);
    if (!decision) throw new Error(`required technology decision missing: ${id}`);
    if (decision.action !== expected.action) {
      throw new Error(`technology decision ${id} must use action ${expected.action}`);
    }
    if (!decision.target.includes(expected.targetIncludes)) {
      throw new Error(`technology decision ${id} target must include ${expected.targetIncludes}`);
    }
  }

  return value as unknown as TechnologyBaseline;
}

export async function verifyCommunicationTechnologyBaseline(
  repositoryRoot: string
): Promise<TechnologyBaselineVerification> {
  const baselinePath = resolve(
    repositoryRoot,
    'docs/architecture/communication-technology-baseline-v1.json'
  );
  const baseline = validateTechnologyBaseline(JSON.parse(await readFile(baselinePath, 'utf8')));
  const packageFiles = [
    'package.json',
    'infra/capacity/package.json',
    'services/converact-service/package.json',
    'services/converact-service/acceptance/kamailio-sip-edge/package.json',
    'services/converact-service/acceptance/livekit-storage-isolation/package.json'
  ];
  for (const relativePath of packageFiles) {
    const manifest = JSON.parse(
      await readFile(resolve(repositoryRoot, relativePath), 'utf8')
    ) as { engines?: { node?: string } };
    if (manifest.engines?.node !== '>=24.0.0 <25.0.0') {
      throw new Error(`${relativePath} must pin the Node 24 LTS compatibility window`);
    }
  }

  const dockerfiles = [
    ['Dockerfile', 'FROM node:24-bookworm-slim'],
    ['infra/capacity/Dockerfile', 'FROM node:24-alpine'],
    ['services/converact-service/Dockerfile', 'FROM node:24-bookworm-slim']
  ] as const;
  for (const [relativePath, expected] of dockerfiles) {
    const source = await readFile(resolve(repositoryRoot, relativePath), 'utf8');
    if (!source.includes(expected) || source.includes('FROM node:23')) {
      throw new Error(`${relativePath} must use the approved Node 24 base image`);
    }
  }

  const rootManifest = JSON.parse(
    await readFile(resolve(repositoryRoot, 'package.json'), 'utf8')
  ) as { dependencies?: Record<string, string> };
  const nodemailer = rootManifest.dependencies?.nodemailer;
  if (!nodemailer || !/^\^?9\.0\.3$/.test(nodemailer)) {
    throw new Error('root nodemailer dependency must be 9.0.3');
  }

  const [
    kamailioRenderer,
    kamailioDockerfile,
    helmValues,
    sipExporterTemplate,
    pythonRequirements,
    pythonLock,
    voiceSessionHandler
  ] = await Promise.all([
    readFile(resolve(repositoryRoot, 'src/agent-runtime/converact/voice/kamailio-config.ts'), 'utf8'),
    readFile(resolve(repositoryRoot, 'infra/converact/kamailio/Dockerfile'), 'utf8'),
    readFile(resolve(repositoryRoot, 'services/converact-service/helm/converact/values.yaml'), 'utf8'),
    readFile(
      resolve(repositoryRoot, 'services/converact-service/helm/converact/templates/sip-exporter.yaml'),
      'utf8'
    ),
    readFile(resolve(repositoryRoot, 'services/ai-agent-py/requirements.txt'), 'utf8'),
    readFile(resolve(repositoryRoot, 'services/ai-agent-py/requirements.lock'), 'utf8'),
    readFile(resolve(repositoryRoot, 'services/ai-agent-py/session_handler.py'), 'utf8')
  ]);
  for (const contract of [
    'loadmodule "siptrace.so"',
    'modparam("siptrace", "hep_version", 3)',
    'modparam("siptrace", "trace_to_database", 0)'
  ]) {
    if (!kamailioRenderer.includes(contract)) {
      throw new Error(`Kamailio HEP connector is missing contract: ${contract}`);
    }
  }
  if (!/include_modules="[^"]*\bsiptrace\b/.test(kamailioDockerfile)) {
    throw new Error('Kamailio image must compile the siptrace module');
  }
  if (!/sipTrace:\s*\n\s+enabled: false/.test(helmValues)) {
    throw new Error('Kamailio HEP connector must remain disabled by default');
  }

  const directRequirements = pythonRequirements
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'));
  if (
    directRequirements.length === 0 ||
    directRequirements.some((requirement) => !/^[A-Za-z0-9_.-]+==[^=\s]+$/.test(requirement))
  ) {
    throw new Error('AI agent direct Python requirements must use exact versions');
  }
  if (!pythonLock.includes('livekit-agents==1.6.6') || pythonLock.includes('>=')) {
    throw new Error('AI agent transitive lock must resolve LiveKit Agents 1.6.6 exactly');
  }
  for (const contract of [
    'prewarm_fnc=prewarm_process',
    'session.on("conversation_item_added")',
    'session.on("agent_state_changed")',
    'turn_handling=build_turn_handling(room_meta)'
  ]) {
    if (!voiceSessionHandler.includes(contract)) {
      throw new Error(`Realtime voice pipeline is missing contract: ${contract}`);
    }
  }
  for (const staleEvent of ['agent_started_speaking', 'agent_stopped_speaking']) {
    if (voiceSessionHandler.includes(staleEvent)) {
      throw new Error(`Realtime voice pipeline still uses removed event: ${staleEvent}`);
    }
  }

  if (!/sipExporter:\s*\n\s+enabled: false/.test(helmValues)) {
    throw new Error('SIP exporter must remain disabled by default');
  }
  for (const contract of [
    'kind: DaemonSet',
    'hostNetwork: true',
    'SIP_EXPORTER_HOST_LABELS',
    'SIP_EXPORTER_TELEMETRY',
    'add: ["BPF", "NET_ADMIN", "NET_RAW"]'
  ]) {
    if (!sipExporterTemplate.includes(contract)) {
      throw new Error(`SIP exporter is missing contract: ${contract}`);
    }
  }
  if (sipExporterTemplate.includes('privileged: true')) {
    throw new Error('SIP exporter must not request unrestricted privileged mode');
  }

  const actionCounts: Record<string, number> = {};
  for (const decision of baseline.decisions) {
    actionCounts[decision.action] = (actionCounts[decision.action] ?? 0) + 1;
  }
  return {
    baseline_id: baseline.baseline_id,
    audited_at: baseline.audited_at,
    decision_count: baseline.decisions.length,
    action_counts: actionCounts,
    node_runtime: '24.x LTS',
    nodemailer: '9.0.3',
    homer_hep_connector: true,
    python_dependency_lock: true,
    realtime_voice_pipeline: true,
    sip_exporter_profile: true
  };
}

function validateDecision(value: unknown, index: number): TechnologyDecision {
  if (!isRecord(value)) throw new Error(`decisions[${index}] must be an object`);
  for (const key of ['id', 'layer', 'capability', 'current', 'target', 'action', 'rollout', 'rationale']) {
    assertNonEmptyString(value[key], `decisions[${index}].${key}`);
  }
  if (!ACTIONS.has(value.action as string)) {
    throw new Error(`decisions[${index}].action is unsupported`);
  }
  if (typeof value.hot_path !== 'boolean') {
    throw new Error(`decisions[${index}].hot_path must be boolean`);
  }
  if (!Array.isArray(value.gates) || value.gates.length === 0) {
    throw new Error(`decisions[${index}].gates must not be empty`);
  }
  value.gates.forEach((item, gateIndex) => {
    assertNonEmptyString(item, `decisions[${index}].gates[${gateIndex}]`);
  });
  return value as unknown as TechnologyDecision;
}

function assertNonEmptyString(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${label} must be a non-empty string`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
