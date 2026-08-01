import { readFile, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';

import {
  validateTechnologyBaseline,
  type TechnologyBaseline
} from './communication-technology-baseline.js';

const MATRIX_PATH = 'docs/architecture/component-authority-matrix-v1.json';
const CHART_ROOT = 'services/converact-service/helm/converact';
const PROFILE_IDS = ['ai', 'benchmark', 'core', 'observability'] as const;
const PRODUCTION_PROFILES = new Set(['ai', 'core', 'observability']);
const COMPONENT_STATUSES = new Set([
  'build_only',
  'deferred',
  'implemented',
  'optional',
  'planned',
  'poc',
  'rejected',
  'replacement'
]);
const AUTHORITY_ROLES = new Set([
  'adapter',
  'candidate',
  'extension',
  'legacy',
  'observer',
  'operator',
  'primary',
  'rejected',
  'tooling'
]);
const DELIVERY_MODES = new Set(['excluded', 'production']);
const POC_ARTIFACT_TOKENS: Readonly<Record<string, readonly string[]>> = {
  rtpengine: ['rtpengine'],
  'siphon-sip': ['siphon'],
  centrifugo: ['centrifugo'],
  'cilium-hubble': ['cilium', 'hubble']
};

export interface DeploymentProfile {
  id: string;
  default: boolean;
  production_eligible: boolean;
  purpose: string;
  components: string[];
}

export interface GovernedComponent {
  id: string;
  baseline_decision_id: string | null;
  purpose: string;
  status: string;
  hot_path: boolean;
  dependencies: string[];
  authority: {
    domain: string;
    role: string;
  };
  profiles: string[];
  default_enabled: boolean;
  config_switch: string;
  delivery: string;
  rollback: string;
  resource_budget: {
    scope: string;
    requests: string;
    limits: string;
    notes: string;
  };
  replacement?: {
    replaces: string;
    retirement_deadline: string;
    exit_gate: string;
  };
  image_contract?: {
    policy: string;
    values_path: string;
    helper: string;
    chart_root?: string;
  };
}

export interface ComponentGovernanceMatrix {
  schema_version: string;
  matrix_id: string;
  audited_at: string;
  default_profile: string;
  principles: string[];
  profiles: Record<string, DeploymentProfile>;
  components: GovernedComponent[];
}

export interface ComponentGovernanceVerification {
  matrix_id: string;
  profiles: string[];
  default_profile: string;
  component_count: number;
  duplicate_primary_authorities: number;
  poc_delivery_violations: number;
  expired_replacements: number;
  unlocked_image_contracts: number;
  formal_bundle_poc_artifacts: number;
}

interface DeliverySourceEntry {
  source: string;
  destination: string;
}

interface ChartSourceEntry {
  path: string;
  source: string;
}

export async function loadComponentGovernance(
  repositoryRoot: string
): Promise<ComponentGovernanceMatrix> {
  const source = await readFile(resolve(repositoryRoot, MATRIX_PATH), 'utf8');
  return validateComponentGovernance(JSON.parse(source));
}

export function validateComponentGovernance(
  value: unknown,
  today = new Date().toISOString().slice(0, 10)
): ComponentGovernanceMatrix {
  if (!isRecord(value)) throw new Error('component governance matrix must be an object');
  if (value.schema_version !== '1.0.0') throw new Error('unsupported component governance schema');
  assertString(value.matrix_id, 'matrix_id');
  assertDate(value.audited_at, 'audited_at');
  if (value.default_profile !== 'core') throw new Error('default deployment profile must be core');
  if (!Array.isArray(value.principles) || value.principles.length < 4) {
    throw new Error('component governance principles are incomplete');
  }
  value.principles.forEach((item, index) => assertString(item, `principles[${index}]`));
  if (!isRecord(value.profiles)) throw new Error('deployment profiles are required');
  if (!Array.isArray(value.components) || value.components.length === 0) {
    throw new Error('governed components are required');
  }

  const profileKeys = Object.keys(value.profiles).sort();
  if (profileKeys.join(',') !== [...PROFILE_IDS].sort().join(',')) {
    throw new Error(`deployment profiles must be exactly ${PROFILE_IDS.join(', ')}`);
  }
  const profiles: Record<string, DeploymentProfile> = {};
  for (const id of PROFILE_IDS) {
    const profile = validateProfile(value.profiles[id], id);
    if (profile.default !== (id === 'core')) {
      throw new Error(`deployment profile ${id} has an invalid default flag`);
    }
    if (profile.production_eligible !== PRODUCTION_PROFILES.has(id)) {
      throw new Error(`deployment profile ${id} has an invalid production eligibility flag`);
    }
    profiles[id] = profile;
  }

  const components = value.components.map((component, index) => validateComponent(component, index));
  const componentIds = new Set<string>();
  for (const component of components) {
    if (componentIds.has(component.id)) throw new Error(`duplicate component id: ${component.id}`);
    componentIds.add(component.id);
  }

  const primaryByDomain = new Map<string, string>();
  for (const component of components) {
    if (component.authority.role === 'primary') {
      const existing = primaryByDomain.get(component.authority.domain);
      if (existing) {
        throw new Error(
          `duplicate primary authority for ${component.authority.domain}: ${existing}, ${component.id}`
        );
      }
      primaryByDomain.set(component.authority.domain, component.id);
    }
    for (const dependency of component.dependencies) {
      if (!componentIds.has(dependency)) {
        throw new Error(`component ${component.id} has unknown dependency ${dependency}`);
      }
    }
    if (component.status === 'poc') {
      if (
        component.profiles.length !== 1 ||
        component.profiles[0] !== 'benchmark' ||
        component.default_enabled ||
        component.delivery !== 'excluded'
      ) {
        throw new Error(`POC component ${component.id} must be benchmark-only and excluded`);
      }
    }
    for (const profileId of component.profiles) {
      if (!PROFILE_IDS.includes(profileId as (typeof PROFILE_IDS)[number])) {
        throw new Error(`component ${component.id} has unknown profile ${profileId}`);
      }
      if (!profiles[profileId]?.components.includes(component.id)) {
        throw new Error(`component ${component.id} is missing from profile ${profileId}`);
      }
    }
    if (component.default_enabled && !component.profiles.includes('core')) {
      throw new Error(`default component ${component.id} must belong to core`);
    }
    if (component.default_enabled && ['deferred', 'optional', 'planned', 'poc', 'rejected'].includes(component.status)) {
      throw new Error(`optional component ${component.id} cannot be enabled by default`);
    }
    if (component.status === 'replacement') {
      if (!component.replacement) {
        throw new Error(`component ${component.id} requires a replacement retirement deadline`);
      }
      assertString(component.replacement.replaces, `${component.id} replacement target`);
      assertDate(
        component.replacement.retirement_deadline,
        `${component.id} replacement retirement deadline`
      );
      assertString(component.replacement.exit_gate, `${component.id} replacement exit gate`);
      if (component.replacement.retirement_deadline < today) {
        throw new Error(
          `replacement retirement deadline expired for ${component.id}: ` +
          component.replacement.retirement_deadline
        );
      }
    } else if (component.replacement) {
      throw new Error(`non-replacement component ${component.id} cannot declare replacement metadata`);
    }
    if (['deferred', 'rejected'].includes(component.status)) {
      if (component.profiles.length > 0 || component.delivery !== 'excluded') {
        throw new Error(`${component.status} component ${component.id} must be excluded`);
      }
    }
  }

  for (const profile of Object.values(profiles)) {
    const seen = new Set<string>();
    for (const componentId of profile.components) {
      if (!componentIds.has(componentId)) {
        throw new Error(`profile ${profile.id} has unknown component ${componentId}`);
      }
      if (seen.has(componentId)) {
        throw new Error(`profile ${profile.id} repeats component ${componentId}`);
      }
      seen.add(componentId);
      const component = components.find((candidate) => candidate.id === componentId);
      if (!component?.profiles.includes(profile.id)) {
        throw new Error(`profile ${profile.id} is missing from component ${componentId}`);
      }
      if (profile.production_eligible && component.status === 'poc') {
        throw new Error(`production profile ${profile.id} contains POC component ${componentId}`);
      }
    }
  }

  return {
    schema_version: value.schema_version,
    matrix_id: value.matrix_id as string,
    audited_at: value.audited_at as string,
    default_profile: value.default_profile as string,
    principles: value.principles as string[],
    profiles,
    components
  };
}

export async function verifyComponentGovernance(
  repositoryRoot: string,
  today = new Date().toISOString().slice(0, 10)
): Promise<ComponentGovernanceVerification> {
  const matrixSource = await readFile(resolve(repositoryRoot, MATRIX_PATH), 'utf8');
  const matrix = validateComponentGovernance(JSON.parse(matrixSource), today);
  const baselineSource = await readFile(
    resolve(repositoryRoot, 'docs/architecture/communication-technology-baseline-v1.json'),
    'utf8'
  );
  const baseline = validateTechnologyBaseline(JSON.parse(baselineSource));
  verifyBaselineCoverage(matrix, baseline);

  const [values, helpers, packageSource, workflowSource, deliveryModule, ...profileSources] =
    await Promise.all([
      readFile(resolve(repositoryRoot, CHART_ROOT, 'values.yaml'), 'utf8'),
      readFile(resolve(repositoryRoot, CHART_ROOT, 'templates/_helpers.tpl'), 'utf8'),
      readFile(resolve(repositoryRoot, 'package.json'), 'utf8'),
      readFile(resolve(repositoryRoot, '.github/workflows/converact-stage2-ci.yml'), 'utf8'),
      import('../converact-delivery-bundle.js'),
      ...PROFILE_IDS.map((id) =>
        readFile(resolve(repositoryRoot, CHART_ROOT, 'profiles', `${id}.values.yaml`), 'utf8')
      )
    ]);
  const chartSources = await loadChartSources(repositoryRoot);

  verifyChartProfileDefaults(values);
  verifyProfileOverlays(matrix, profileSources);
  verifyProfileGuards(helpers);
  await verifyImmutableImages(matrix, repositoryRoot);
  verifyChartPocIsolation(matrix, chartSources);
  verifyDeliveryIsolation(
    matrix,
    deliveryModule.DELIVERY_SOURCE_FILES as readonly DeliverySourceEntry[]
  );
  verifyCiContract(packageSource, workflowSource);

  return {
    matrix_id: matrix.matrix_id,
    profiles: Object.keys(matrix.profiles).sort(),
    default_profile: matrix.default_profile,
    component_count: matrix.components.length,
    duplicate_primary_authorities: 0,
    poc_delivery_violations: 0,
    expired_replacements: 0,
    unlocked_image_contracts: 0,
    formal_bundle_poc_artifacts: 0
  };
}

function validateProfile(value: unknown, expectedId: string): DeploymentProfile {
  if (!isRecord(value)) throw new Error(`deployment profile ${expectedId} must be an object`);
  if (value.id !== expectedId) throw new Error(`deployment profile key and id differ for ${expectedId}`);
  if (typeof value.default !== 'boolean' || typeof value.production_eligible !== 'boolean') {
    throw new Error(`deployment profile ${expectedId} flags must be boolean`);
  }
  assertString(value.purpose, `deployment profile ${expectedId} purpose`);
  if (!Array.isArray(value.components) || value.components.some((item) => typeof item !== 'string')) {
    throw new Error(`deployment profile ${expectedId} components must be strings`);
  }
  return value as unknown as DeploymentProfile;
}

function validateComponent(value: unknown, index: number): GovernedComponent {
  if (!isRecord(value)) throw new Error(`components[${index}] must be an object`);
  for (const key of ['id', 'purpose', 'status', 'config_switch', 'delivery', 'rollback']) {
    assertString(value[key], `components[${index}].${key}`);
  }
  if (value.baseline_decision_id !== null && typeof value.baseline_decision_id !== 'string') {
    throw new Error(`components[${index}].baseline_decision_id must be a string or null`);
  }
  if (!COMPONENT_STATUSES.has(value.status as string)) {
    throw new Error(`component ${String(value.id)} has unsupported status`);
  }
  if (!DELIVERY_MODES.has(value.delivery as string)) {
    throw new Error(`component ${String(value.id)} has unsupported delivery mode`);
  }
  if (typeof value.hot_path !== 'boolean' || typeof value.default_enabled !== 'boolean') {
    throw new Error(`component ${String(value.id)} boolean fields are invalid`);
  }
  for (const key of ['dependencies', 'profiles']) {
    if (!Array.isArray(value[key]) || (value[key] as unknown[]).some((item) => typeof item !== 'string')) {
      throw new Error(`component ${String(value.id)} ${key} must be strings`);
    }
  }
  if (!isRecord(value.authority)) throw new Error(`component ${String(value.id)} authority is required`);
  assertString(value.authority.domain, `component ${String(value.id)} authority domain`);
  assertString(value.authority.role, `component ${String(value.id)} authority role`);
  if (!AUTHORITY_ROLES.has(value.authority.role as string)) {
    throw new Error(`component ${String(value.id)} has unsupported authority role`);
  }
  if (!isRecord(value.resource_budget)) {
    throw new Error(`component ${String(value.id)} resource budget is required`);
  }
  for (const key of ['scope', 'requests', 'limits', 'notes']) {
    assertString(value.resource_budget[key], `component ${String(value.id)} resource budget ${key}`);
  }
  if (value.image_contract !== undefined) {
    if (!isRecord(value.image_contract)) {
      throw new Error(`component ${String(value.id)} image contract must be an object`);
    }
    for (const key of ['policy', 'values_path', 'helper']) {
      assertString(value.image_contract[key], `component ${String(value.id)} image contract ${key}`);
    }
    if (value.image_contract.chart_root !== undefined) {
      assertString(
        value.image_contract.chart_root,
        `component ${String(value.id)} image contract chart_root`
      );
      if (
        value.image_contract.chart_root.startsWith('/') ||
        value.image_contract.chart_root.split('/').includes('..')
      ) {
        throw new Error(
          `component ${String(value.id)} image contract chart_root must stay inside the repository`
        );
      }
    }
    if (value.image_contract.policy !== 'immutable') {
      throw new Error(`component ${String(value.id)} production image must be immutable`);
    }
  }
  return value as unknown as GovernedComponent;
}

function verifyBaselineCoverage(
  matrix: ComponentGovernanceMatrix,
  baseline: TechnologyBaseline
): void {
  const refs = matrix.components
    .map((component) => component.baseline_decision_id)
    .filter((id): id is string => id !== null);
  const uniqueRefs = new Set(refs);
  if (refs.length !== uniqueRefs.size) throw new Error('technology baseline decision is referenced twice');
  for (const decision of baseline.decisions) {
    const component = matrix.components.find(
      (candidate) => candidate.baseline_decision_id === decision.id
    );
    if (!component) throw new Error(`technology baseline decision is ungoverned: ${decision.id}`);
    if (component.hot_path !== decision.hot_path) {
      throw new Error(`component ${component.id} hot_path differs from technology baseline`);
    }
    const expectedStatus: Record<string, string> = {
      defer: 'deferred',
      poc: 'poc',
      reject: 'rejected',
      replace: 'replacement'
    };
    if (expectedStatus[decision.action] && component.status !== expectedStatus[decision.action]) {
      throw new Error(`component ${component.id} status differs from ${decision.action} decision`);
    }
  }
  if (uniqueRefs.size !== baseline.decisions.length) {
    throw new Error('component authority matrix and technology baseline coverage differ');
  }
}

function verifyChartProfileDefaults(values: string): void {
  const expected: Record<string, string> = {
    'deploymentProfiles.core': 'true',
    'deploymentProfiles.ai': 'false',
    'deploymentProfiles.observability': 'false',
    'deploymentProfiles.benchmark': 'false',
    'clamav.enabled': 'false',
    'fileSecurity.scanWorkerEnabled': '"0"',
    'fileSecurity.derivativeWorkerEnabled': '"0"',
    'voice.enabled': 'false',
    'tinode.enabled': 'false',
    'notificationWorker.enabled': 'false',
    'backup.enabled': 'false'
  };
  for (const [path, expectedValue] of Object.entries(expected)) {
    const actual = yamlScalarAtPath(values, path);
    if (actual !== expectedValue) {
      throw new Error(
        `Helm core profile ${path} must be ${expectedValue}; received ${actual ?? 'missing'}`
      );
    }
  }
}

function verifyProfileGuards(helpers: string): void {
  for (const contract of [
    'define "converact.profileValidate"',
    'deploymentProfiles.core is mandatory',
    'AI workers require deploymentProfiles.ai=true',
    'monitoring and SIP tracing require deploymentProfiles.observability=true',
    'include "converact.profileValidate"'
  ]) {
    if (!helpers.includes(contract)) throw new Error(`Helm profile guard is missing ${contract}`);
  }
}

function verifyChartPocIsolation(
  matrix: ComponentGovernanceMatrix,
  chartSources: ChartSourceEntry[]
): void {
  const pocComponents = matrix.components.filter((component) => component.status === 'poc');
  for (const entry of chartSources) {
    const haystack = `${entry.path}\n${entry.source}`.toLowerCase();
    for (const component of pocComponents) {
      const tokens = POC_ARTIFACT_TOKENS[component.id] ?? [component.id];
      if (tokens.some((token) => haystack.includes(token.toLowerCase()))) {
        throw new Error(`production Chart contains POC component ${component.id} in ${entry.path}`);
      }
    }
  }
}

async function loadChartSources(
  repositoryRoot: string,
  relativeChartRoot = CHART_ROOT
): Promise<ChartSourceEntry[]> {
  const chartRoot = resolve(repositoryRoot, relativeChartRoot);
  const entries = await readdir(chartRoot, { recursive: true, withFileTypes: true });
  return Promise.all(
    entries.filter((entry) => entry.isFile()).map(async (entry) => {
      const absolutePath = resolve(entry.parentPath, entry.name);
      return {
        path: absolutePath.slice(chartRoot.length + 1),
        source: await readFile(absolutePath, 'utf8')
      };
    })
  );
}

function verifyProfileOverlays(
  matrix: ComponentGovernanceMatrix,
  sources: string[]
): void {
  const pocIds = matrix.components
    .filter((component) => component.status === 'poc')
    .map((component) => component.id);
  PROFILE_IDS.forEach((id, index) => {
    const source = sources[index] ?? '';
    for (const profileId of PROFILE_IDS) {
      const actual = yamlScalarAtPath(source, `deploymentProfiles.${profileId}`);
      const required = profileId === 'core' || profileId === id;
      if (required && actual !== 'true') {
        throw new Error(
          `Helm profile overlay ${id} must set deploymentProfiles.${profileId}=true`
        );
      }
      if (!required && actual !== undefined && actual !== 'false') {
        throw new Error(
          `Helm profile overlay ${id} may omit deploymentProfiles.${profileId} or set it to false`
        );
      }
    }
    if (id !== 'benchmark') {
      for (const pocId of pocIds) {
        if (source.includes(pocId)) {
          throw new Error(`production Helm profile ${id} mentions POC component ${pocId}`);
        }
      }
    }
  });
}

async function verifyImmutableImages(
  matrix: ComponentGovernanceMatrix,
  repositoryRoot: string
): Promise<void> {
  const componentsByChart = new Map<string, GovernedComponent[]>();
  for (const component of matrix.components) {
    if (!component.image_contract) continue;
    const chartRoot = component.image_contract.chart_root ?? CHART_ROOT;
    const components = componentsByChart.get(chartRoot) ?? [];
    components.push(component);
    componentsByChart.set(chartRoot, components);
  }

  for (const [chartRoot, components] of componentsByChart) {
    const [values, helpers, chartSources] = await Promise.all([
      readFile(resolve(repositoryRoot, chartRoot, 'values.yaml'), 'utf8'),
      readFile(resolve(repositoryRoot, chartRoot, 'templates/_helpers.tpl'), 'utf8'),
      loadChartSources(repositoryRoot, chartRoot)
    ]);
    const chartSource = chartSources.map((entry) => entry.source).join('\n');
    const approvedHelpers = new Set(
      components.map((component) => currentImageHelper(component.image_contract!.helper))
    );
    for (const component of components) {
      const contract = component.image_contract!;
      if (!yamlDeclaresPath(values, contract.values_path)) {
        throw new Error(`unlocked image contract for ${component.id}: missing values digest path`);
      }
      const helperName = currentImageHelper(contract.helper).replace(
        /[.*+?^${}()|[\]\\]/g,
        '\\$&'
      );
      const start = helpers.search(new RegExp(`define "${helperName}"`));
      if (start < 0) {
        throw new Error(`unlocked image contract for ${component.id}: helper missing`);
      }
      const helperBody = helpers.slice(start, helpers.indexOf('{{- end }}', start));
      if (!helperBody.includes('^sha256:[a-f0-9]{64}$')) {
        throw new Error(`unlocked image contract for ${component.id}: sha256 validation missing`);
      }
      if (!new RegExp(`include "${helperName}"`).test(chartSource)) {
        throw new Error(`unlocked image contract for ${component.id}: helper is not rendered`);
      }
    }
    verifyNoMutableChartImages(chartSources, approvedHelpers);
  }
}

/**
 * The versioned governance matrix is immutable and therefore keeps its
 * pre-rename Helm helper identifiers. Resolve only those exact identifiers to
 * the current chart ABI; arbitrary legacy-looking names remain invalid.
 */
function currentImageHelper(contractHelper: string): string {
  const aliases: Readonly<Record<string, string>> = {
    'ivekit.image': 'converact.image',
    'ivekit.kamailioImage': 'converact.kamailioImage',
    'ivekit.rustpbxImage': 'converact.rustpbxImage',
    'ivekit.sipExporterImage': 'converact.sipExporterImage',
    'ivekit.tinodeImage': 'converact.tinodeImage',
    'ivekit.clamavImage': 'converact.clamavImage',
    'ivekit-homer.image': 'converact-homer.image'
  };
  return aliases[contractHelper] ?? contractHelper;
}

function verifyNoMutableChartImages(
  chartSources: ChartSourceEntry[],
  approvedHelpers: Set<string>
): void {
  for (const entry of chartSources.filter((candidate) => candidate.path.startsWith('templates/'))) {
    const variableHelpers = new Map<string, string>();
    for (const match of entry.source.matchAll(/\$(\w+)\s*:=\s*include\s+"([^"]+)"/g)) {
      variableHelpers.set(match[1], match[2]);
    }
    for (const [index, line] of entry.source.split(/\r?\n/).entries()) {
      const image = /^\s*image:\s*(.+)$/.exec(line);
      if (!image) continue;
      const directHelper = /include\s+"([^"]+)"/.exec(image[1])?.[1];
      const variable = /\{\{\s*\$(\w+)/.exec(image[1])?.[1];
      const helper = directHelper ?? (variable ? variableHelpers.get(variable) : undefined);
      if (!helper || !approvedHelpers.has(helper)) {
        throw new Error(
          `unlocked image contract in ${entry.path}:${index + 1}; use an approved immutable helper`
        );
      }
    }
  }
}

function verifyDeliveryIsolation(
  matrix: ComponentGovernanceMatrix,
  entries: readonly DeliverySourceEntry[]
): void {
  for (const requiredPath of [
    MATRIX_PATH,
    'docs/architecture/communication-technology-baseline-v1.json',
    'docs/converact-component-governance.md',
    `${CHART_ROOT}/profiles/core.values.yaml`,
    `${CHART_ROOT}/profiles/ai.values.yaml`,
    `${CHART_ROOT}/profiles/observability.values.yaml`,
    `${CHART_ROOT}/profiles/benchmark.values.yaml`
  ]) {
    if (!entries.some((entry) => entry.source === requiredPath || entry.destination === requiredPath)) {
      throw new Error(`formal delivery bundle is missing governance artifact ${requiredPath}`);
    }
  }
  const deployEntries = entries.filter((entry) =>
    /^(acceptance|capacity-runtime|components|deploy|edge|service)\//.test(entry.destination)
  );
  for (const component of matrix.components.filter((candidate) => candidate.status === 'poc')) {
    const tokens = POC_ARTIFACT_TOKENS[component.id] ?? [component.id];
    if (deployEntries.some((entry) => {
      const haystack = `${entry.source}\n${entry.destination}`.toLowerCase();
      return tokens.some((token) => haystack.includes(token.toLowerCase()));
    })) {
      throw new Error(`formal delivery bundle contains POC artifact ${component.id}`);
    }
  }
}

function verifyCiContract(packageSource: string, workflowSource: string): void {
  const packageJson = JSON.parse(packageSource) as { scripts?: Record<string, string> };
  if (!packageJson.scripts?.['verify:component-governance']?.includes('verify-component-governance.ts')) {
    throw new Error('package.json must expose verify:component-governance');
  }
  if (!workflowSource.includes('npm run verify:component-governance')) {
    throw new Error('Stage 2 CI must execute component governance verification');
  }
  for (const path of [MATRIX_PATH, `${CHART_ROOT}/profiles/**`, 'scripts/lib/component-governance.ts']) {
    if (!workflowSource.includes(path)) {
      throw new Error(`Stage 2 CI path filters must include ${path}`);
    }
  }
}

function yamlDeclaresPath(source: string, dottedPath: string): boolean {
  const target = dottedPath.split('.');
  const stack: Array<{ indent: number; key: string }> = [];
  for (const line of source.split(/\r?\n/)) {
    if (!line.trim() || line.trimStart().startsWith('#')) continue;
    const match = /^(\s*)([A-Za-z0-9_-]+):/.exec(line);
    if (!match) continue;
    const indent = match[1].length;
    while (stack.length && stack[stack.length - 1].indent >= indent) stack.pop();
    stack.push({ indent, key: match[2] });
    if (stack.map((entry) => entry.key).join('.') === target.join('.')) return true;
  }
  return false;
}

function yamlScalarAtPath(source: string, dottedPath: string): string | undefined {
  const target = dottedPath.split('.');
  const stack: Array<{ indent: number; key: string }> = [];
  for (const line of source.split(/\r?\n/)) {
    if (!line.trim() || line.trimStart().startsWith('#')) continue;
    const match = /^(\s*)([A-Za-z0-9_-]+):(?:\s*(.*))?$/.exec(line);
    if (!match) continue;
    const indent = match[1].length;
    while (stack.length && stack[stack.length - 1].indent >= indent) stack.pop();
    stack.push({ indent, key: match[2] });
    if (stack.map((entry) => entry.key).join('.') !== target.join('.')) continue;
    const raw = (match[3] ?? '').replace(/\s+#.*$/, '').trim();
    return raw || undefined;
  }
  return undefined;
}

function assertString(value: unknown, name: string): asserts value is string {
  if (typeof value !== 'string' || value.trim() === '') throw new Error(`${name} must be non-empty`);
}

function assertDate(value: unknown, name: string): asserts value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new Error(`${name} must use YYYY-MM-DD`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
