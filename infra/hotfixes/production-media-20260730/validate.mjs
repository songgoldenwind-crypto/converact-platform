#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const DIGEST_REFERENCE = /^[^\s@]+@sha256:[a-f0-9]{64}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const IMAGE_ID = /^sha256:[a-f0-9]{64}$/;
const OPC_HOTFIX_IMAGE =
  /^ivekit\/opc:production-media-20260730-[a-f0-9]{12}$/;
const OPC_BASE_IMAGE = /^ivekit\/opc:im-final8-[a-f0-9]{12}$/;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,254}$/;
const PROFILE_ID = /^[a-z][a-z0-9-]{2,63}-v[1-9][0-9]*$/;
const MAX_EXCEPTION_MS = 72 * 60 * 60 * 1000;
const CELL_CONTROL_ENDPOINT = 'http://livekit-component-node:3210';
const LIVEKIT_OWNER_ENDPOINT = 'http://127.0.0.1:3210';
const HOTFIX_NETWORK = 'ivekit-owner-control';
const HOST_LOOPBACK_NETWORK = 'ivekit-owner-loopback';
const CELL_COMPOSE_PROFILE = 'voice-capacity';
const HOTFIX_ROOT = dirname(fileURLToPath(import.meta.url));
const REPOSITORY_ROOT = resolve(HOTFIX_ROOT, '../../..');
const RETAINED_LIVEKIT_IMAGE_ID =
  'sha256:95b4473a03aeba9d2c36c62450f1bc924ad0638a44a9edd4cae46860aed23963';
const RETAINED_CAPACITY_IMAGE_ID =
  'sha256:83296c08de7b798cdb753527d216efd5b7dc1ef6ec8a05c1233f16a4f9feece3';
const RETAINED_LIVEKIT_IMAGE =
  `ivekit/livekit-server@${RETAINED_LIVEKIT_IMAGE_ID}`;
const RETAINED_CAPACITY_IMAGE =
  `ivekit/opc@${RETAINED_CAPACITY_IMAGE_ID}`;
const PAYLOAD_PATHS = readFileSync(
  resolve(HOTFIX_ROOT, 'payload.paths'),
  'utf8'
).trim().split('\n');
const PAYLOAD_FILE_COUNT = 13;
const FREEZE_IDENTIFIER =
  /^[A-Za-z0-9][A-Za-z0-9@._:+/-]{0,254}$/;
const FREEZE_RULE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

export function parseEnvText(source) {
  const env = {};
  for (const original of source.split(/\r?\n/)) {
    let line = original.trim();
    if (!line || line.startsWith('#')) continue;
    if (line.startsWith('export ')) line = line.slice('export '.length).trim();
    const separator = line.indexOf('=');
    if (separator < 1) throw new Error('hotfix environment contains an invalid line');
    const key = line.slice(0, separator).trim();
    if (!/^[A-Z][A-Z0-9_]*$/.test(key)) {
      throw new Error('hotfix environment contains an invalid key');
    }
    let value = line.slice(separator + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    env[key] = value;
  }
  return env;
}

export function validateHotfixEnv(env, options = {}) {
  const fragments = validateHotfixFragments(env, options);
  validateMergedCellEnv(env, fragments);
  return {
    nodeId: fragments.node.node_id,
    expiresAt: fragments.expiresAt
  };
}

export function validateHotfixFragments(env, options = {}) {
  const now = validDate(options.now || new Date(), 'current time');
  const allowPlaceholders = options.allowPlaceholders === true;
  validateOpcHotfixReferences(env, allowPlaceholders);
  const retainedImages = [
    [
      'LIVEKIT_SERVER_IMAGE',
      'LIVEKIT_SERVER_IMAGE_ID',
      RETAINED_LIVEKIT_IMAGE,
      RETAINED_LIVEKIT_IMAGE_ID
    ],
    [
      'IVEKIT_CAPACITY_TOOLS_IMAGE',
      'IVEKIT_CAPACITY_TOOLS_IMAGE_ID',
      RETAINED_CAPACITY_IMAGE,
      RETAINED_CAPACITY_IMAGE_ID
    ]
  ];
  for (const [imageName, idName, retainedImage, retainedId] of retainedImages) {
    if (required(env, imageName) !== retainedImage ||
        required(env, idName) !== retainedId) {
      throw new Error(
        `${imageName} and ${idName} must match the retained server binary`
      );
    }
  }
  validateCreateFreeze(env);
  validateDeploymentEvidenceEnv(env, allowPlaceholders);

  const token = required(env, 'OPC_IVEKIT_COMPONENT_NODE_TOKEN');
  if (!allowPlaceholders &&
      (token.length < 24 || token.length > 512 ||
        /change[_-]?me|replace|placeholder|example/i.test(token))) {
    throw new Error('OPC_IVEKIT_COMPONENT_NODE_TOKEN is invalid');
  }
  const nodeId = safeId(required(env, 'LIVEKIT_OWNER_NODE_ID'), 'LiveKit owner node ID');
  const profileId = required(env, 'LIVEKIT_COMPONENT_NODE_PROFILE_IDS');
  if (!PROFILE_ID.test(profileId) || profileId.includes(',')) {
    throw new Error('LiveKit hotfix requires exactly one valid placement profile');
  }
  if (required(env, 'LIVEKIT_COMPONENT_NODE_LOOPBACK_PORT') !== '3210') {
    throw new Error('LiveKit component-node loopback port must be 3210');
  }
  const publicUrl = credentialFreeWss(
    required(env, 'LIVEKIT_PUBLIC_URL'),
    'LIVEKIT_PUBLIC_URL'
  );
  const providerEndpoint = liveKitProviderEndpoint(publicUrl);
  const regionId = safeId(required(env, 'IVEKIT_CELL_REGION_ID'), 'Cell region ID');
  const zoneId = safeId(required(env, 'IVEKIT_CELL_ZONE_ID'), 'Cell zone ID');
  const cellId = safeId(required(env, 'IVEKIT_CELL_ID'), 'Cell ID');

  const rawExpiry = required(env, 'HOTFIX_NON_MTLS_EXPIRES_AT');
  let expiresAt = rawExpiry;
  if (allowPlaceholders &&
      rawExpiry === 'replace_with_future_utc_at_most_72h') {
    expiresAt = rawExpiry;
  } else {
    const expiry = validDate(new Date(rawExpiry), 'HOTFIX_NON_MTLS_EXPIRES_AT');
    const lifetime = expiry.getTime() - now.getTime();
    if (lifetime <= 0) {
      throw new Error('HOTFIX_NON_MTLS_EXPIRES_AT must be in the future');
    }
    if (lifetime > MAX_EXCEPTION_MS) {
      throw new Error('HOTFIX_NON_MTLS_EXPIRES_AT must be within 72 hours');
    }
    expiresAt = expiry.toISOString();
  }

  const dimensions = jsonObject(
    required(env, 'LIVEKIT_COMPONENT_NODE_DIMENSIONS_JSON'),
    'LIVEKIT_COMPONENT_NODE_DIMENSIONS_JSON'
  );
  validateVideoDimension(dimensions['video.participants']);
  if (Object.keys(dimensions).length !== 1) {
    throw new Error('LiveKit hotfix dimensions must contain only video.participants');
  }

  const node = jsonObject(
    required(env, 'LIVEKIT_COMPONENT_NODE_JSON'),
    'LIVEKIT_COMPONENT_NODE_JSON'
  );
  if (node.node_id !== nodeId ||
      node.endpoint !== providerEndpoint ||
      node.control_endpoint !== CELL_CONTROL_ENDPOINT ||
      node.state !== 'accepting' ||
      JSON.stringify(node.profile_ids) !== JSON.stringify([profileId]) ||
      JSON.stringify(node.interaction_kinds) !== JSON.stringify(['livekit_av'])) {
    throw new Error('LIVEKIT_COMPONENT_NODE_JSON identity or routing contract is invalid');
  }
  validateVideoDimension(jsonObjectValue(node.dimensions, 'node dimensions')['video.participants']);

  const probe = jsonObject(
    required(env, 'LIVEKIT_COMPONENT_NODE_PROBE_JSON'),
    'LIVEKIT_COMPONENT_NODE_PROBE_JSON'
  );
  if (probe.component !== 'livekit' ||
      probe.instance_id !== nodeId ||
      probe.region_id !== regionId ||
      probe.zone_id !== zoneId ||
      probe.cell_id !== cellId ||
      probe.profile_id !== profileId ||
      probe.health_url !== `${CELL_CONTROL_ENDPOINT}/operationalz` ||
      probe.metrics_url !== `${CELL_CONTROL_ENDPOINT}/metrics` ||
      probe.drain_metric !== 'ivekit_component_node_route_drain_active') {
    throw new Error('LIVEKIT_COMPONENT_NODE_PROBE_JSON identity or endpoint contract is invalid');
  }
  const probeDimensions = jsonObjectValue(probe.dimensions, 'probe dimensions');
  validateProbeDimension(probeDimensions['video.participants']);
  validateEvidenceDigest(
    String(probe.release_id || '').replace(/^livekit@sha256:/, ''),
    'LiveKit release digest',
    allowPlaceholders
  );
  if (probe.release_id !==
      `livekit@${RETAINED_LIVEKIT_IMAGE_ID}`) {
    throw new Error('LiveKit probe release must match the retained image ID');
  }
  validateEvidenceDigest(
    String(probe.profile_sha256 || ''),
    'capacity profile digest',
    allowPlaceholders
  );

  return {
    dimensions,
    node,
    probe,
    nodeId,
    profileId,
    regionId,
    zoneId,
    cellId,
    publicUrl,
    providerEndpoint,
    expiresAt
  };
}

export function validateLiveKitImageInspect(
  inspect,
  expectedImage,
  expectedImageId = RETAINED_LIVEKIT_IMAGE_ID
) {
  validateExactDigestImageInspect(
    inspect,
    expectedImage,
    expectedImageId,
    'LiveKit'
  );
  const image = firstInspectRecord(inspect, 'LiveKit image inspect');
  const labels = objectValue(objectValue(image.Config, 'LiveKit image Config').Labels || {}, 'LiveKit image labels');
  if (labels['io.ivekit.owner-contract'] !== 'component-node-v1') {
    throw new Error('LiveKit image owner contract label is missing');
  }
}

export function validateExactDigestImageInspect(
  inspect,
  expectedImage,
  expectedImageId,
  label
) {
  validateDigestReference(expectedImage, label);
  if (!IMAGE_ID.test(expectedImageId)) {
    throw new Error(`${label} expected image ID is invalid`);
  }
  const image = firstInspectRecord(inspect, `${label} image inspect`);
  if (image.Id !== expectedImageId) {
    throw new Error(`${label} image ID does not match the retained binary`);
  }
  validateRepoDigest(image, expectedImage, `${label} image`);
}

export function validateDigestImageInspect(
  inspect,
  expectedImage,
  expectedImageId,
  label
) {
  validateExactDigestImageInspect(
    inspect,
    expectedImage,
    expectedImageId,
    label
  );
}

export function validateInternalNetworkInspect(inspect, expectedName) {
  const network = firstInspectRecord(inspect, 'Docker network inspect');
  if (network.Name !== expectedName) {
    throw new Error(`Docker network name must be ${expectedName}`);
  }
  if (network.Internal !== true) {
    throw new Error(`Docker network ${expectedName} must be internal`);
  }
}

export function validateHostLoopbackNetworkInspect(inspect, expectedName) {
  const network = firstInspectRecord(inspect, 'Docker loopback network inspect');
  if (network.Name !== expectedName) {
    throw new Error(`Docker loopback network name must be ${expectedName}`);
  }
  if (network.Internal !== false) {
    throw new Error(`Docker network ${expectedName} must not be internal`);
  }
}

export function validateControlNetworkRuntime(
  controlNetworkInspect,
  loopbackNetworkInspect,
  containerInspects,
  expected
) {
  const networkName = required(expected, 'network');
  const loopbackNetworkName = required(expected, 'loopbackNetwork');
  const componentContainer = required(expected, 'componentContainer');
  const alias = required(expected, 'alias');
  const hostPort = required(expected, 'hostPort');
  validateInternalNetworkInspect(controlNetworkInspect, networkName);
  validateHostLoopbackNetworkInspect(
    loopbackNetworkInspect,
    loopbackNetworkName
  );
  const network = firstInspectRecord(
    controlNetworkInspect,
    'Docker control network inspect'
  );
  const members = Object.values(
    objectValue(network.Containers || {}, 'Docker control network members')
  ).map((member) => objectValue(member, 'Docker control network member'));
  const componentMembers = members.filter(
    (member) => member.Name === componentContainer
  );
  if (componentMembers.length !== 1 ||
      !String(componentMembers[0].IPv4Address || '').match(
        /^(?:[0-9]{1,3}\.){3}[0-9]{1,3}\/[0-9]{1,2}$/
      )) {
    throw new Error(
      'control network must contain exactly one component container with IPv4'
    );
  }

  const inspects = flattenInspectRecords(containerInspects);
  const memberNames = new Set(members.map((member) => member.Name));
  const memberInspects = inspects.filter((inspect) =>
    memberNames.has(normalizeContainerName(inspect.Name))
  );
  if (memberInspects.length !== memberNames.size) {
    throw new Error('every control network member must have inspect evidence');
  }
  let aliasCount = 0;
  for (const inspect of memberInspects) {
    const networks = objectValue(
      objectValue(
        inspect.NetworkSettings,
        'container NetworkSettings'
      ).Networks,
      'container networks'
    );
    const endpoint = objectValue(
      networks[networkName],
      `${networkName} container endpoint`
    );
    const aliases = arrayValue(endpoint.Aliases || [], 'container aliases');
    aliasCount += aliases.filter((value) => value === alias).length;
    if (!String(endpoint.IPAddress || '').match(
      /^(?:[0-9]{1,3}\.){3}[0-9]{1,3}$/
    )) {
      throw new Error('control network member is missing an IPv4 address');
    }
  }
  if (aliasCount !== 1) {
    throw new Error(`control network alias ${alias} must be unique`);
  }

  const componentInspect = memberInspects.find(
    (inspect) => normalizeContainerName(inspect.Name) === componentContainer
  );
  if (!componentInspect) {
    throw new Error('component container inspect evidence is missing');
  }
  const loopbackNetwork = firstInspectRecord(
    loopbackNetworkInspect,
    'Docker loopback network inspect'
  );
  const loopbackMembers = Object.values(
    objectValue(
      loopbackNetwork.Containers || {},
      'Docker loopback network members'
    )
  ).map((member) => objectValue(member, 'Docker loopback network member'));
  if (loopbackMembers.length !== 1 ||
      loopbackMembers[0].Name !== componentContainer ||
      !String(loopbackMembers[0].IPv4Address || '').match(
        /^(?:[0-9]{1,3}\.){3}[0-9]{1,3}\/[0-9]{1,2}$/
      )) {
    throw new Error(
      'host loopback transport must contain only the component container'
    );
  }
  const componentNetworks = objectValue(
    objectValue(
      componentInspect.NetworkSettings,
      'component NetworkSettings'
    ).Networks,
    'component networks'
  );
  const loopbackEndpoint = objectValue(
    componentNetworks[loopbackNetworkName],
    `${loopbackNetworkName} component endpoint`
  );
  if (!String(loopbackEndpoint.IPAddress || '').match(
    /^(?:[0-9]{1,3}\.){3}[0-9]{1,3}$/
  )) {
    throw new Error('component loopback transport is missing an IPv4 address');
  }
  const portBindings = objectValue(
    objectValue(componentInspect.HostConfig, 'component HostConfig')
      .PortBindings || {},
    'component port bindings'
  );
  const bindings = arrayValue(
    portBindings['3210/tcp'],
    'component 3210/tcp bindings'
  );
  if (bindings.length !== 1 ||
      objectValue(bindings[0], 'component port binding').HostIp !==
        '127.0.0.1' ||
      objectValue(bindings[0], 'component port binding').HostPort !==
        hostPort) {
    throw new Error(
      'component control port must have one 127.0.0.1:3210 binding'
    );
  }
  const activePorts = objectValue(
    objectValue(
      componentInspect.NetworkSettings,
      'component NetworkSettings'
    ).Ports || {},
    'component active port bindings'
  );
  const activeBindings = activePorts['3210/tcp'];
  if (!Array.isArray(activeBindings) ||
      activeBindings.length !== 1 ||
      objectValue(
        activeBindings[0],
        'component active port binding'
      ).HostIp !== '127.0.0.1' ||
      objectValue(
        activeBindings[0],
        'component active port binding'
      ).HostPort !== hostPort) {
    throw new Error(
      'component control port must have one active loopback binding'
    );
  }
}

export function validatePayloadManifest(
  source,
  expectedPaths = PAYLOAD_PATHS,
  options = {}
) {
  const allowAbsent = options.allowAbsent === true;
  const lines = String(source).trimEnd().split('\n');
  const entries = lines.map((line) => {
    const match = line.match(/^([a-f0-9]{64}|ABSENT) {2}([^\s].*)$/);
    if (!match ||
        (!allowAbsent && match[1] === 'ABSENT') ||
        match[2].startsWith('/') ||
        match[2].split('/').includes('..')) {
      throw new Error('payload manifest contains an invalid entry');
    }
    return { digest: match[1], path: match[2] };
  });
  const paths = entries.map((entry) => entry.path);
  if (new Set(paths).size !== paths.length ||
      JSON.stringify(paths) !== JSON.stringify(expectedPaths)) {
    throw new Error('payload manifest does not match the exact path allowlist');
  }
}

export function validateCanonicalPatch(source, expectedPaths = PAYLOAD_PATHS) {
  const paths = [...String(source).matchAll(/^diff --git a\/(.+) b\/(.+)$/gm)]
    .flatMap((match) => [match[1], match[2]]);
  if (paths.length === 0 ||
      paths.some((path) => !expectedPaths.includes(path))) {
    throw new Error('hotfix patch contains a path outside the payload allowlist');
  }
}

export function validateContainerComposeContract(inspect, expected) {
  const container = firstInspectRecord(inspect, 'container inspect');
  const name = normalizeContainerName(container.Name);
  if (name !== required(expected, 'container')) {
    throw new Error('container name does not match the retained deployment');
  }
  const labels = objectValue(
    objectValue(container.Config, 'container Config').Labels || {},
    'container labels'
  );
  if (labels['com.docker.compose.project'] !==
        required(expected, 'project') ||
      labels['com.docker.compose.project.working_dir'] !==
        required(expected, 'workingDir')) {
    throw new Error('container Compose project ownership does not match');
  }
  const actualFiles = String(
    labels['com.docker.compose.project.config_files'] || ''
  ).split(',').filter(Boolean);
  if (JSON.stringify(actualFiles) !==
      JSON.stringify(arrayValue(expected.configFiles, 'expected config files'))) {
    throw new Error('container Compose config file ownership does not match');
  }
}

export function validateComposeFileEvidence(
  actualPath,
  expectedPath,
  expectedSha256
) {
  const normalizedActual = resolve(absolutePath(actualPath, 'Compose path'));
  const normalizedExpected = resolve(
    absolutePath(expectedPath, 'expected Compose path')
  );
  if (normalizedActual !== normalizedExpected) {
    throw new Error('Compose path does not match retained container evidence');
  }
  const source = readFileSync(normalizedActual);
  if (sha256(source) !== expectedSha256) {
    throw new Error('Compose file SHA-256 does not match retained evidence');
  }
}

export function validateRenderedComposeContracts(input) {
  const apiBase = objectValue(input.apiBase, 'API base Compose');
  const api = objectValue(input.api, 'API hotfix Compose');
  const cellBase = objectValue(input.cellBase, 'Cell base Compose');
  const cell = objectValue(input.cell, 'Cell hotfix Compose');
  const liveKitBase = objectValue(input.liveKitBase, 'LiveKit base Compose');
  const liveKit = objectValue(input.liveKit, 'LiveKit hotfix Compose');
  for (const service of ['opc', 'postgres-migrate']) {
    validateRenderedService(
      apiBase,
      api,
      service,
      required(input, 'opcImage'),
      []
    );
  }
  for (const service of [
    'cell-admission',
    'rustpbx-capacity-projector'
  ]) {
    validateRenderedService(
      cellBase,
      cell,
      service,
      required(input, 'capacityImage'),
      [HOTFIX_NETWORK]
    );
  }
  validateRenderedService(
    cellBase,
    cell,
    'rustpbx-placement-snapshot-projector',
    required(input, 'capacityImage'),
    []
  );
  const expectedLiveKitNode = objectValue(
    input.liveKitNode,
    'expected LiveKit node'
  );
  const renderedCellEnvironment = objectValue(
    renderedService(cell, 'cell-admission').environment,
    'rendered Cell admission environment'
  );
  const renderedLiveKitNodes = jsonArray(
    renderedCellEnvironment.OPC_IVEKIT_CELL_NODES_JSON,
    'rendered Cell nodes'
  ).filter((node) =>
    objectValue(node, 'rendered Cell node').node_id ===
      expectedLiveKitNode.node_id
  );
  if (renderedLiveKitNodes.length !== 1 ||
      stable(renderedLiveKitNodes[0]) !== stable(expectedLiveKitNode)) {
    throw new Error(
      'rendered LiveKit node does not match the validated hotfix fragment'
    );
  }
  validateRenderedService(
    liveKitBase,
    liveKit,
    'livekit',
    required(input, 'liveKitImage'),
    []
  );
  const liveKitService = renderedService(liveKit, 'livekit');
  const liveKitEnvironment = objectValue(
    liveKitService.environment,
    'LiveKit rendered environment'
  );
  if (liveKitEnvironment.IVEKIT_COMPONENT_NODE_ENDPOINT !==
      LIVEKIT_OWNER_ENDPOINT) {
    throw new Error('host-network LiveKit must use the component-node loopback endpoint');
  }
  const component = renderedService(liveKit, 'livekit-component-node');
  if (component.image !== required(input, 'capacityImage') ||
      component.pull_policy !== 'never' ||
      Number(component.pids_limit) !== 128 ||
      !['256m', '268435456'].includes(String(component.mem_limit))) {
    throw new Error('component-node rendered resource/image contract is invalid');
  }
  const componentNetworks = renderedNetworkNames(component.networks);
  if (JSON.stringify(componentNetworks) !==
      JSON.stringify([HOST_LOOPBACK_NETWORK, HOTFIX_NETWORK].sort())) {
    throw new Error(
      'component-node must use only the owner control and host loopback networks'
    );
  }
  const componentNetworkSettings = objectValue(
    component.networks,
    'component-node rendered networks'
  );
  const loopbackSettings = objectValue(
    componentNetworkSettings[HOST_LOOPBACK_NETWORK],
    'component-node loopback network'
  );
  if (Number(loopbackSettings.gw_priority) !== 1) {
    throw new Error('component-node loopback network must own the gateway');
  }
  validateTopLevelResources(apiBase, api);
  validateTopLevelResources(cellBase, cell);
  validateTopLevelResources(liveKitBase, liveKit);
}

export function validateOpcHotfixImageInspect(inspect, expected) {
  const imageName = required(expected, 'image');
  const imageId = required(expected, 'imageId');
  const baseImageId = required(expected, 'baseImageId');
  const basePayloadManifestSha256 = required(
    expected,
    'basePayloadManifestSha256'
  );
  const payloadManifestSha256 = required(
    expected,
    'payloadManifestSha256'
  );
  const patchSha256 = required(expected, 'patchSha256');
  const payloadFileCount = required(expected, 'payloadFileCount');
  if (!OPC_HOTFIX_IMAGE.test(imageName) ||
      !IMAGE_ID.test(imageId) ||
      !IMAGE_ID.test(baseImageId) ||
      !SHA256.test(basePayloadManifestSha256) ||
      !SHA256.test(payloadManifestSha256) ||
      !SHA256.test(patchSha256) ||
      payloadFileCount !== String(PAYLOAD_FILE_COUNT)) {
    throw new Error('OPC hotfix image evidence is invalid');
  }
  if (imageId === baseImageId) {
    throw new Error('OPC hotfix image must differ from the base image');
  }

  const image = firstInspectRecord(inspect, 'OPC hotfix image inspect');
  if (image.Id !== imageId) {
    throw new Error('OPC hotfix local image ID does not match evidence');
  }
  if (!arrayValue(image.RepoTags, 'OPC hotfix image RepoTags')
    .includes(imageName)) {
    throw new Error('OPC hotfix local image tag does not match evidence');
  }
  const labels = objectValue(
    objectValue(image.Config, 'OPC hotfix image Config').Labels || {},
    'OPC hotfix image labels'
  );
  const expectedLabels = {
    'io.ivekit.hotfix': 'production-media-20260730',
    'io.ivekit.hotfix.base-image-id': baseImageId,
    'io.ivekit.hotfix.base-payload-manifest-sha256':
      basePayloadManifestSha256,
    'io.ivekit.hotfix.payload-manifest-sha256': payloadManifestSha256,
    'io.ivekit.hotfix.patch-sha256': patchSha256,
    'io.ivekit.hotfix.payload-file-count': payloadFileCount
  };
  for (const [name, value] of Object.entries(expectedLabels)) {
    if (labels[name] !== value) {
      throw new Error(`OPC hotfix image label ${name} does not match evidence`);
    }
  }
}

export function validateOpcBaseImageInspect(
  inspect,
  expectedImage,
  expectedImageId
) {
  if (!OPC_BASE_IMAGE.test(expectedImage) ||
      !IMAGE_ID.test(expectedImageId)) {
    throw new Error('OPC base image evidence is invalid');
  }
  const image = firstInspectRecord(inspect, 'OPC base image inspect');
  if (image.Id !== expectedImageId) {
    throw new Error('OPC base image ID does not match evidence');
  }
  if (!arrayValue(image.RepoTags, 'OPC base image RepoTags')
    .includes(expectedImage)) {
    throw new Error('OPC base image tag does not match evidence');
  }
}

function validateOpcHotfixReferences(env, allowPlaceholders) {
  const baseImage = required(env, 'IVEKIT_OPC_BASE_IMAGE');
  const image = required(env, 'IVEKIT_OPC_HOTFIX_IMAGE');
  const imageId = required(env, 'IVEKIT_OPC_HOTFIX_IMAGE_ID');
  const baseImageId = required(env, 'IVEKIT_OPC_BASE_IMAGE_ID');
  const basePayloadManifestSha256 = required(
    env,
    'IVEKIT_OPC_BASE_PAYLOAD_MANIFEST_SHA256'
  );
  const payloadManifestSha256 = required(
    env,
    'IVEKIT_OPC_HOTFIX_PAYLOAD_MANIFEST_SHA256'
  );
  const patchSha256 = required(env, 'IVEKIT_OPC_HOTFIX_PATCH_SHA256');
  if (!OPC_BASE_IMAGE.test(baseImage)) {
    throw new Error('IVEKIT_OPC_BASE_IMAGE is invalid');
  }
  if (!OPC_HOTFIX_IMAGE.test(image)) {
    throw new Error('IVEKIT_OPC_HOTFIX_IMAGE is invalid');
  }
  for (const [name, value] of [
    ['IVEKIT_OPC_HOTFIX_IMAGE_ID', imageId],
    ['IVEKIT_OPC_BASE_IMAGE_ID', baseImageId]
  ]) {
    if (!IMAGE_ID.test(value)) throw new Error(`${name} is invalid`);
    if (!allowPlaceholders && value === `sha256:${'0'.repeat(64)}`) {
      throw new Error(`${name} must replace the example image ID`);
    }
  }
  for (const [name, value] of [
    [
      'IVEKIT_OPC_BASE_PAYLOAD_MANIFEST_SHA256',
      basePayloadManifestSha256
    ],
    [
      'IVEKIT_OPC_HOTFIX_PAYLOAD_MANIFEST_SHA256',
      payloadManifestSha256
    ],
    ['IVEKIT_OPC_HOTFIX_PATCH_SHA256', patchSha256]
  ]) {
    validateEvidenceDigest(value, name, allowPlaceholders);
  }
  if (required(env, 'IVEKIT_OPC_PAYLOAD_FILE_COUNT') !==
      String(PAYLOAD_FILE_COUNT)) {
    throw new Error(
      `IVEKIT_OPC_PAYLOAD_FILE_COUNT must be ${PAYLOAD_FILE_COUNT}`
    );
  }
}

function validateCreateFreeze(env) {
  if (required(env, 'OPC_IVEKIT_MEDIA_CALL_CREATE_FREEZE') !== '1') {
    throw new Error('media Call create freeze must remain enabled');
  }
  if (!FREEZE_RULE_ID.test(
    required(env, 'OPC_IVEKIT_MEDIA_CALL_CREATE_FREEZE_RULE_ID')
  )) {
    throw new Error('media Call create freeze rule ID is invalid');
  }
  if (required(env, 'OPC_IVEKIT_MEDIA_CALL_CREATE_REQUIRE_PLACEMENT') !== '1') {
    throw new Error('media Call create must require placement');
  }
  for (const name of [
    'OPC_IVEKIT_MEDIA_CALL_CREATE_CANARY_TENANT_IDS',
    'OPC_IVEKIT_MEDIA_CALL_CREATE_CANARY_SUBJECTS'
  ]) {
    const raw = String(env[name] || '').trim();
    if (!raw) continue;
    if (Buffer.byteLength(raw, 'utf8') > 8 * 1024) {
      throw new Error(`${name} exceeds the bounded allowlist size`);
    }
    const entries = raw.split(',').map((value) => value.trim());
    if (entries.length > 128 ||
        entries.some((value) => !FREEZE_IDENTIFIER.test(value)) ||
        new Set(entries).size !== entries.length) {
      throw new Error(`${name} must be an exact, unique allowlist`);
    }
  }
}

function validateDeploymentEvidenceEnv(env, allowPlaceholders) {
  for (const name of [
    'IVEKIT_API_PROJECT_NAME',
    'IVEKIT_CELL_PROJECT_NAME',
    'IVEKIT_LIVEKIT_PROJECT_NAME',
    'IVEKIT_OPC_CONTAINER_NAME',
    'IVEKIT_CELL_CONTAINER_NAME',
    'IVEKIT_LIVEKIT_CONTAINER_NAME',
    'LIVEKIT_COMPONENT_NODE_CONTAINER_NAME'
  ]) {
    safeId(required(env, name), name);
  }
  for (const name of [
    'IVEKIT_API_COMPOSE_WORKING_DIR',
    'IVEKIT_CELL_COMPOSE_WORKING_DIR',
    'IVEKIT_LIVEKIT_COMPOSE_WORKING_DIR',
    'IVEKIT_API_BASE_COMPOSE_PATH',
    'IVEKIT_API_VOICE_COMPOSE_PATH',
    'IVEKIT_CELL_BASE_COMPOSE_PATH',
    'IVEKIT_CELL_VOICE_COMPOSE_PATH',
    'IVEKIT_LIVEKIT_BASE_COMPOSE_PATH',
    'IVEKIT_LIVEKIT_STORAGE_COMPOSE_PATH'
  ]) {
    absolutePath(required(env, name), name);
  }
  for (const name of [
    'IVEKIT_API_BASE_COMPOSE_SHA256',
    'IVEKIT_API_VOICE_COMPOSE_SHA256',
    'IVEKIT_CELL_BASE_COMPOSE_SHA256',
    'IVEKIT_CELL_VOICE_COMPOSE_SHA256',
    'IVEKIT_LIVEKIT_BASE_COMPOSE_SHA256',
    'IVEKIT_LIVEKIT_STORAGE_COMPOSE_SHA256'
  ]) {
    validateEvidenceDigest(required(env, name), name, allowPlaceholders);
  }
  const migrationGuard = required(env, 'IVEKIT_HOTFIX_MIGRATION_GUARD_PATH');
  if (migrationGuard !==
      'scripts/run-production-media-hotfix-migration.ts') {
    throw new Error('guarded migration runner path is invalid');
  }
  for (const name of [
    'IVEKIT_OPC_BASE_PAYLOAD_MANIFEST_PATH',
    'IVEKIT_OPC_HOTFIX_PAYLOAD_MANIFEST_PATH',
    'IVEKIT_OPC_HOTFIX_PATCH_PATH'
  ]) {
    const value = required(env, name);
    if (allowPlaceholders && value.startsWith('replace_with_absolute_')) {
      continue;
    }
    absolutePath(value, name);
  }
}

function validateMergedCellEnv(env, fragments) {
  const kinds = required(env, 'IVEKIT_CELL_INTERACTION_KINDS')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
  if (!kinds.includes('livekit_av')) {
    throw new Error('IVEKIT_CELL_INTERACTION_KINDS must include livekit_av');
  }

  const cellDimensions = jsonObject(
    required(env, 'IVEKIT_CELL_DIMENSIONS_JSON'),
    'IVEKIT_CELL_DIMENSIONS_JSON'
  );
  validateVideoDimension(cellDimensions['video.participants']);

  const nodes = jsonArray(
    required(env, 'IVEKIT_CELL_NODES_JSON'),
    'IVEKIT_CELL_NODES_JSON'
  );
  const matchingNodes = nodes.filter((value) =>
    objectValue(value, 'Cell node').node_id === fragments.nodeId
  );
  if (matchingNodes.length !== 1) {
    throw new Error('IVEKIT_CELL_NODES_JSON must contain exactly one LiveKit owner node');
  }
  const mergedNode = objectValue(matchingNodes[0], 'LiveKit Cell node');
  if (mergedNode.endpoint !== fragments.providerEndpoint ||
      mergedNode.control_endpoint !== CELL_CONTROL_ENDPOINT ||
      !arrayValue(mergedNode.profile_ids, 'LiveKit node profile IDs').includes(fragments.profileId) ||
      !arrayValue(mergedNode.interaction_kinds, 'LiveKit node kinds').includes('livekit_av')) {
    throw new Error('merged LiveKit Cell node does not match the hotfix fragment');
  }
  validateVideoDimension(
    jsonObjectValue(mergedNode.dimensions, 'merged node dimensions')['video.participants']
  );

  const probes = jsonArray(
    required(env, 'IVEKIT_CELL_CAPACITY_PROBES_JSON'),
    'IVEKIT_CELL_CAPACITY_PROBES_JSON'
  );
  const matchingProbes = probes.filter((value) => {
    const probe = objectValue(value, 'Cell capacity probe');
    return probe.component === 'livekit' &&
      probe.instance_id === fragments.nodeId;
  });
  if (matchingProbes.length !== 1) {
    throw new Error('IVEKIT_CELL_CAPACITY_PROBES_JSON must contain exactly one LiveKit probe');
  }
  const mergedProbe = objectValue(matchingProbes[0], 'LiveKit capacity probe');
  if (mergedProbe.health_url !== `${CELL_CONTROL_ENDPOINT}/operationalz` ||
      mergedProbe.metrics_url !== `${CELL_CONTROL_ENDPOINT}/metrics`) {
    throw new Error('merged LiveKit capacity probe endpoints are invalid');
  }
  validateProbeDimension(
    jsonObjectValue(mergedProbe.dimensions, 'merged probe dimensions')['video.participants']
  );

  if (required(env, 'OPC_IVEKIT_PLACEMENT_PROFILE_ID') !== fragments.profileId) {
    throw new Error('placement profile must match the LiveKit owner profile');
  }
  const policy = jsonObject(
    required(env, 'OPC_IVEKIT_PLACEMENT_MEDIA_POLICY_JSON'),
    'OPC_IVEKIT_PLACEMENT_MEDIA_POLICY_JSON'
  );
  const participantCapacity = jsonObjectValue(
    policy.per_participant_capacity,
    'media per-participant capacity'
  );
  if (policy.profile_id !== fragments.profileId ||
      participantCapacity['video.participants'] !== 1) {
    throw new Error('media placement policy must reserve one video.participants unit');
  }

  const topology = jsonObject(
    required(env, 'OPC_IVEKIT_PLACEMENT_TOPOLOGY_JSON'),
    'OPC_IVEKIT_PLACEMENT_TOPOLOGY_JSON'
  );
  const cells = arrayValue(topology.regions, 'placement regions')
    .flatMap((region) =>
      arrayValue(objectValue(region, 'placement region').zones, 'placement zones')
    )
    .flatMap((zone) =>
      arrayValue(objectValue(zone, 'placement zone').cells, 'placement cells')
    )
    .map((cell) => objectValue(cell, 'placement Cell'));
  const cell = cells.find((candidate) => candidate.cell_id === fragments.cellId);
  if (!cell ||
      !arrayValue(cell.supported_interaction_kinds, 'Cell interaction kinds')
        .includes('livekit_av') ||
      !arrayValue(cell.supported_profile_ids, 'Cell profile IDs')
        .includes(fragments.profileId)) {
    throw new Error('placement topology must advertise livekit_av on the target Cell');
  }
}

function validateVideoDimension(value) {
  const dimension = objectValue(value, 'video.participants dimension');
  if (dimension.safe_capacity !== 2) {
    throw new Error('LiveKit hotfix safe capacity must be exactly 2');
  }
  if (dimension.unit !== 'participants' ||
      dimension.used !== 0 ||
      dimension.reserved !== 0) {
    throw new Error('LiveKit hotfix video.participants dimension is invalid');
  }
}

function validateProbeDimension(value) {
  const dimension = objectValue(value, 'video.participants probe dimension');
  if (dimension.safe_capacity !== 2) {
    throw new Error('LiveKit hotfix probe safe capacity must be exactly 2');
  }
  const labels = objectValue(dimension.labels, 'probe labels');
  if (dimension.metric !== 'ivekit_component_node_capacity_used' ||
      dimension.aggregation !== 'sum' ||
      dimension.unit !== 'participants' ||
      labels.dimension !== 'video.participants') {
    throw new Error('LiveKit hotfix video.participants probe is invalid');
  }
}

function validateEvidenceDigest(value, label, allowPlaceholders) {
  if (!SHA256.test(value)) throw new Error(`${label} is invalid`);
  if (!allowPlaceholders && value === '0'.repeat(64)) {
    throw new Error(`${label} must replace the example digest`);
  }
}

function validateDigestReference(value, label) {
  if (!DIGEST_REFERENCE.test(value)) {
    throw new Error(`${label} must be pinned by digest`);
  }
}

function validateRepoDigest(inspect, expectedImage, label) {
  const expectedDigest = expectedImage.slice(expectedImage.indexOf('@') + 1);
  const repoDigests = arrayValue(inspect.RepoDigests, `${label} RepoDigests`);
  if (!repoDigests.some((value) =>
    typeof value === 'string' && value.endsWith(`@${expectedDigest}`)
  )) {
    throw new Error(`${label} local digest does not match the configured digest`);
  }
}

function firstInspectRecord(value, label) {
  const candidate = Array.isArray(value) ? value[0] : value;
  return objectValue(candidate, label);
}

function credentialFreeWss(value, label) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${label} must be a valid WSS URL`);
  }
  if (url.protocol !== 'wss:' ||
      url.username ||
      url.password ||
      url.search ||
      url.hash) {
    throw new Error(`${label} must be a credential-free WSS URL`);
  }
  return url.toString().replace(/\/$/, '');
}

function liveKitProviderEndpoint(publicUrl) {
  const url = new URL(publicUrl);
  url.protocol = 'https:';
  return url.toString().replace(/\/$/, '');
}

function required(env, name) {
  const value = String(env[name] || '').trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function safeId(value, label) {
  if (!SAFE_ID.test(value)) throw new Error(`${label} is invalid`);
  return value;
}

function validDate(value, label) {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    throw new Error(`${label} is invalid`);
  }
  return value;
}

function jsonObject(source, label) {
  let value;
  try {
    value = JSON.parse(source);
  } catch {
    throw new Error(`${label} must be valid JSON`);
  }
  return objectValue(value, label);
}

function jsonArray(source, label) {
  let value;
  try {
    value = JSON.parse(source);
  } catch {
    throw new Error(`${label} must be valid JSON`);
  }
  return arrayValue(value, label);
}

function objectValue(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value;
}

function jsonObjectValue(value, label) {
  return objectValue(value, label);
}

function arrayValue(value, label) {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  return value;
}

function absolutePath(value, label) {
  const path = String(value || '');
  if (!path.startsWith('/') || resolve(path) !== path) {
    throw new Error(`${label} must be an absolute normalized path`);
  }
  return path;
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function flattenInspectRecords(values) {
  return arrayValue(values, 'container inspect evidence').flatMap((value) =>
    Array.isArray(value) ? value : [value]
  ).map((value) => objectValue(value, 'container inspect record'));
}

function normalizeContainerName(value) {
  return String(value || '').replace(/^\//, '');
}

function renderedService(config, name) {
  const services = objectValue(config.services, 'rendered Compose services');
  return objectValue(services[name], `rendered Compose service ${name}`);
}

function renderedNetworkNames(value) {
  if (Array.isArray(value)) return [...value].sort();
  if (!value) return [];
  return Object.keys(objectValue(value, 'rendered service networks')).sort();
}

function validateRenderedService(
  baseConfig,
  hotfixConfig,
  name,
  expectedImage,
  additiveNetworks
) {
  const base = renderedService(baseConfig, name);
  const hotfix = renderedService(hotfixConfig, name);
  if (hotfix.image !== expectedImage || hotfix.pull_policy !== 'never') {
    throw new Error(`${name} rendered image/pull contract is invalid`);
  }
  if (hotfix.build !== undefined) {
    throw new Error(`${name} rendered build configuration was not removed`);
  }
  if (stable(base.volumes || []) !== stable(hotfix.volumes || [])) {
    throw new Error(`${name} rendered volume bindings changed`);
  }
  if ((base.network_mode || null) !== (hotfix.network_mode || null)) {
    throw new Error(`${name} rendered network mode changed unexpectedly`);
  }
  const expectedNetworks = new Set([
    ...renderedNetworkNames(base.networks),
    ...additiveNetworks
  ]);
  if (stable([...expectedNetworks].sort()) !==
      stable(renderedNetworkNames(hotfix.networks))) {
    throw new Error(`${name} rendered network bindings changed unexpectedly`);
  }
}

function validateTopLevelResources(baseConfig, hotfixConfig) {
  for (const section of ['volumes', 'networks']) {
    const before = Object.keys(baseConfig[section] || {}).sort();
    const after = new Set(Object.keys(hotfixConfig[section] || {}));
    if (before.some((name) => !after.has(name))) {
      throw new Error(`rendered Compose removed a top-level ${section} entry`);
    }
  }
}

function stable(value) {
  if (Array.isArray(value)) return JSON.stringify(value.map(stableValue));
  return JSON.stringify(stableValue(value));
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, stableValue(child)])
    );
  }
  return value;
}

function validatePayloadEvidenceFiles(env) {
  const baseManifestPath = absolutePath(
    required(env, 'IVEKIT_OPC_BASE_PAYLOAD_MANIFEST_PATH'),
    'IVEKIT_OPC_BASE_PAYLOAD_MANIFEST_PATH'
  );
  const payloadManifestPath = absolutePath(
    required(env, 'IVEKIT_OPC_HOTFIX_PAYLOAD_MANIFEST_PATH'),
    'IVEKIT_OPC_HOTFIX_PAYLOAD_MANIFEST_PATH'
  );
  const patchPath = absolutePath(
    required(env, 'IVEKIT_OPC_HOTFIX_PATCH_PATH'),
    'IVEKIT_OPC_HOTFIX_PATCH_PATH'
  );
  const baseManifest = readFileSync(baseManifestPath);
  const payloadManifest = readFileSync(payloadManifestPath);
  const patch = readFileSync(patchPath);
  if (sha256(baseManifest) !==
        required(env, 'IVEKIT_OPC_BASE_PAYLOAD_MANIFEST_SHA256') ||
      sha256(payloadManifest) !==
        required(env, 'IVEKIT_OPC_HOTFIX_PAYLOAD_MANIFEST_SHA256') ||
      sha256(patch) !== required(env, 'IVEKIT_OPC_HOTFIX_PATCH_SHA256')) {
    throw new Error('payload evidence file SHA-256 does not match environment');
  }
  validatePayloadManifest(
    baseManifest.toString('utf8'),
    PAYLOAD_PATHS,
    { allowAbsent: true }
  );
  validatePayloadManifest(payloadManifest.toString('utf8'));
  validateCanonicalPatch(patch.toString('utf8'));
}

function parseArguments(argv) {
  const options = {
    envFile: '',
    apiEnvFile: '',
    cellEnvFile: '',
    liveKitEnvFile: '',
    contractOnly: false,
    deployed: false,
    runtimeControl: false,
    network: HOTFIX_NETWORK,
    loopbackNetwork: HOST_LOOPBACK_NETWORK,
    liveKitBases: [
      resolve(REPOSITORY_ROOT, 'infra/livekit/docker-compose.yml')
    ],
    cellBases: [
      resolve(REPOSITORY_ROOT, 'infra/ivekit/docker-compose.yml'),
      resolve(REPOSITORY_ROOT, 'infra/ivekit/docker-compose.voice.yml')
    ],
    apiBases: [
      resolve(REPOSITORY_ROOT, 'infra/ivekit/docker-compose.yml'),
      resolve(REPOSITORY_ROOT, 'infra/ivekit/docker-compose.voice.yml')
    ]
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--contract-only') {
      options.contractOnly = true;
      continue;
    }
    if (argument === '--deployed') {
      options.deployed = true;
      continue;
    }
    if (argument === '--runtime-control') {
      options.runtimeControl = true;
      continue;
    }
    const value = argv[index + 1];
    if (!value) throw new Error(`${argument} requires a value`);
    if (argument === '--env-file') options.envFile = resolve(value);
    else if (argument === '--api-env-file') options.apiEnvFile = resolve(value);
    else if (argument === '--cell-env-file') options.cellEnvFile = resolve(value);
    else if (argument === '--livekit-env-file') {
      options.liveKitEnvFile = resolve(value);
    }
    else if (argument === '--network') options.network = value;
    else if (argument === '--loopback-network') {
      options.loopbackNetwork = value;
    }
    else if (argument === '--livekit-base') {
      options.liveKitBases = [resolve(value)];
    }
    else if (argument === '--livekit-storage-base') {
      options.liveKitBases.push(resolve(value));
    }
    else if (argument === '--cell-base') options.cellBases = [resolve(value)];
    else if (argument === '--cell-voice-base') options.cellBases.push(resolve(value));
    else if (argument === '--api-base') options.apiBases = [resolve(value)];
    else if (argument === '--api-voice-base') options.apiBases.push(resolve(value));
    else throw new Error(`unsupported argument: ${argument}`);
    index += 1;
  }
  if (!options.envFile) throw new Error('--env-file is required');
  options.apiEnvFile ||= options.envFile;
  options.cellEnvFile ||= options.envFile;
  options.liveKitEnvFile ||= options.envFile;
  return options;
}

function dockerJson(args, failure) {
  try {
    return JSON.parse(execFileSync('docker', args, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe']
    }));
  } catch {
    throw new Error(failure);
  }
}

function dockerComposeConfig(
  envFile,
  composeFiles,
  project,
  failure,
  profiles = []
) {
  const args = [
    'compose',
    '--project-name',
    project
  ];
  for (const profile of profiles) args.push('--profile', profile);
  args.push('--env-file', envFile);
  for (const file of composeFiles) args.push('-f', file);
  args.push('config', '--format', 'json');
  try {
    return JSON.parse(execFileSync('docker', args, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe']
    }));
  } catch {
    throw new Error(failure);
  }
}

function validateComposeEvidence(options, env) {
  const entries = [
    [
      options.apiBases[0],
      env.IVEKIT_API_BASE_COMPOSE_PATH,
      env.IVEKIT_API_BASE_COMPOSE_SHA256
    ],
    [
      options.apiBases[1],
      env.IVEKIT_API_VOICE_COMPOSE_PATH,
      env.IVEKIT_API_VOICE_COMPOSE_SHA256
    ],
    [
      options.cellBases[0],
      env.IVEKIT_CELL_BASE_COMPOSE_PATH,
      env.IVEKIT_CELL_BASE_COMPOSE_SHA256
    ],
    [
      options.cellBases[1],
      env.IVEKIT_CELL_VOICE_COMPOSE_PATH,
      env.IVEKIT_CELL_VOICE_COMPOSE_SHA256
    ],
    [
      options.liveKitBases[0],
      env.IVEKIT_LIVEKIT_BASE_COMPOSE_PATH,
      env.IVEKIT_LIVEKIT_BASE_COMPOSE_SHA256
    ],
    [
      options.liveKitBases[1],
      env.IVEKIT_LIVEKIT_STORAGE_COMPOSE_PATH,
      env.IVEKIT_LIVEKIT_STORAGE_COMPOSE_SHA256
    ]
  ];
  for (const [actualPath, expectedPath, expectedSha256] of entries) {
    if (!actualPath) {
      throw new Error('every retained Compose file must be supplied');
    }
    validateComposeFileEvidence(actualPath, expectedPath, expectedSha256);
  }
}

function validateRunningContainerContracts(options, env) {
  const override = {
    api: resolve(HOTFIX_ROOT, 'api-hotfix.override.yml'),
    cell: resolve(HOTFIX_ROOT, 'cell-owner.override.yml'),
    liveKit: resolve(HOTFIX_ROOT, 'livekit-owner.override.yml')
  };
  const contracts = [
    {
      container: env.IVEKIT_OPC_CONTAINER_NAME,
      project: env.IVEKIT_API_PROJECT_NAME,
      workingDir: env.IVEKIT_API_COMPOSE_WORKING_DIR,
      configFiles: [
        ...options.apiBases,
        ...(options.deployed ? [override.api] : [])
      ]
    },
    {
      container: env.IVEKIT_CELL_CONTAINER_NAME,
      project: env.IVEKIT_CELL_PROJECT_NAME,
      workingDir: env.IVEKIT_CELL_COMPOSE_WORKING_DIR,
      configFiles: [
        ...options.cellBases,
        ...(options.deployed ? [override.cell] : [])
      ]
    },
    {
      container: env.IVEKIT_LIVEKIT_CONTAINER_NAME,
      project: env.IVEKIT_LIVEKIT_PROJECT_NAME,
      workingDir: env.IVEKIT_LIVEKIT_COMPOSE_WORKING_DIR,
      configFiles: [
        ...options.liveKitBases,
        ...(options.deployed ? [override.liveKit] : [])
      ]
    }
  ];
  for (const contract of contracts) {
    validateContainerComposeContract(
      dockerJson(
        ['container', 'inspect', contract.container],
        `${contract.container} inspect failed`
      ),
      contract
    );
  }
}

function runCli() {
  const options = parseArguments(process.argv.slice(2));
  const env = parseEnvText(readFileSync(options.envFile, 'utf8'));
  if (options.contractOnly) {
    validateHotfixFragments(env, {
      allowPlaceholders: true,
      now: new Date()
    });
    process.stdout.write('production media hotfix contract validation passed\n');
    return;
  }

  const result = validateHotfixEnv(env, { now: new Date() });
  validatePayloadEvidenceFiles(env);
  const liveKitInspect = dockerJson(
    ['image', 'inspect', env.LIVEKIT_SERVER_IMAGE],
    'LiveKit image inspect failed'
  );
  validateLiveKitImageInspect(
    liveKitInspect,
    env.LIVEKIT_SERVER_IMAGE,
    env.LIVEKIT_SERVER_IMAGE_ID
  );
  const capacityInspect = dockerJson(
    ['image', 'inspect', env.IVEKIT_CAPACITY_TOOLS_IMAGE],
    'capacity-tools image inspect failed'
  );
  validateDigestImageInspect(
    capacityInspect,
    env.IVEKIT_CAPACITY_TOOLS_IMAGE,
    env.IVEKIT_CAPACITY_TOOLS_IMAGE_ID,
    'IVEKIT_CAPACITY_TOOLS_IMAGE'
  );
  const opcHotfixInspect = dockerJson(
    ['image', 'inspect', env.IVEKIT_OPC_HOTFIX_IMAGE],
    'OPC hotfix image inspect failed'
  );
  validateOpcHotfixImageInspect(opcHotfixInspect, {
    image: env.IVEKIT_OPC_HOTFIX_IMAGE,
    imageId: env.IVEKIT_OPC_HOTFIX_IMAGE_ID,
    baseImageId: env.IVEKIT_OPC_BASE_IMAGE_ID,
    basePayloadManifestSha256:
      env.IVEKIT_OPC_BASE_PAYLOAD_MANIFEST_SHA256,
    payloadManifestSha256:
      env.IVEKIT_OPC_HOTFIX_PAYLOAD_MANIFEST_SHA256,
    patchSha256: env.IVEKIT_OPC_HOTFIX_PATCH_SHA256,
    payloadFileCount: env.IVEKIT_OPC_PAYLOAD_FILE_COUNT
  });
  const opcBaseInspect = dockerJson(
    ['image', 'inspect', env.IVEKIT_OPC_BASE_IMAGE],
    'OPC base image inspect failed'
  );
  validateOpcBaseImageInspect(
    opcBaseInspect,
    env.IVEKIT_OPC_BASE_IMAGE,
    env.IVEKIT_OPC_BASE_IMAGE_ID
  );
  validateComposeEvidence(options, env);
  validateRunningContainerContracts(options, env);
  const networkInspect = dockerJson(
    ['network', 'inspect', options.network],
    'Docker control network inspect failed'
  );
  validateInternalNetworkInspect(networkInspect, options.network);
  const loopbackNetworkInspect = dockerJson(
    ['network', 'inspect', options.loopbackNetwork],
    'Docker loopback network inspect failed'
  );
  validateHostLoopbackNetworkInspect(
    loopbackNetworkInspect,
    options.loopbackNetwork
  );

  const liveKitBaseConfig = dockerComposeConfig(
    options.liveKitEnvFile,
    options.liveKitBases,
    env.IVEKIT_LIVEKIT_PROJECT_NAME,
    'LiveKit base Compose validation failed'
  );
  const liveKitHotfixConfig = dockerComposeConfig(
    options.liveKitEnvFile,
    [...options.liveKitBases, resolve(HOTFIX_ROOT, 'livekit-owner.override.yml')],
    env.IVEKIT_LIVEKIT_PROJECT_NAME,
    'LiveKit hotfix Compose validation failed'
  );
  const cellBaseConfig = dockerComposeConfig(
    options.cellEnvFile,
    options.cellBases,
    env.IVEKIT_CELL_PROJECT_NAME,
    'Cell base Compose validation failed',
    [CELL_COMPOSE_PROFILE]
  );
  const cellHotfixConfig = dockerComposeConfig(
    options.cellEnvFile,
    [...options.cellBases, resolve(HOTFIX_ROOT, 'cell-owner.override.yml')],
    env.IVEKIT_CELL_PROJECT_NAME,
    'Cell hotfix Compose validation failed',
    [CELL_COMPOSE_PROFILE]
  );
  const apiBaseConfig = dockerComposeConfig(
    options.apiEnvFile,
    options.apiBases,
    env.IVEKIT_API_PROJECT_NAME,
    'OPC API base Compose validation failed'
  );
  const apiHotfixConfig = dockerComposeConfig(
    options.apiEnvFile,
    [...options.apiBases, resolve(HOTFIX_ROOT, 'api-hotfix.override.yml')],
    env.IVEKIT_API_PROJECT_NAME,
    'OPC API hotfix Compose validation failed'
  );
  validateRenderedComposeContracts({
    apiBase: apiBaseConfig,
    api: apiHotfixConfig,
    cellBase: cellBaseConfig,
    cell: cellHotfixConfig,
    liveKitBase: liveKitBaseConfig,
    liveKit: liveKitHotfixConfig,
    opcImage: env.IVEKIT_OPC_HOTFIX_IMAGE,
    capacityImage: env.IVEKIT_CAPACITY_TOOLS_IMAGE,
    liveKitImage: env.LIVEKIT_SERVER_IMAGE,
    liveKitNode: jsonObject(
      required(env, 'LIVEKIT_COMPONENT_NODE_JSON'),
      'LIVEKIT_COMPONENT_NODE_JSON'
    )
  });
  if (options.runtimeControl) {
    const members = Object.keys(
      objectValue(
        firstInspectRecord(networkInspect, 'Docker control network inspect')
          .Containers || {},
        'Docker control network members'
      )
    );
    const containerInspects = members.map((id) =>
      dockerJson(
        ['container', 'inspect', id],
        'control network member inspect failed'
      )
    );
    validateControlNetworkRuntime(
      networkInspect,
      loopbackNetworkInspect,
      containerInspects,
      {
      network: options.network,
      loopbackNetwork: options.loopbackNetwork,
      componentContainer: env.LIVEKIT_COMPONENT_NODE_CONTAINER_NAME,
      alias: 'livekit-component-node',
      hostPort: env.LIVEKIT_COMPONENT_NODE_LOOPBACK_PORT
      }
    );
  }
  process.stdout.write(
    `production media hotfix validation passed node_id=${result.nodeId} ` +
    `expires_at=${result.expiresAt}\n`
  );
}

if (process.argv[1] &&
    pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    runCli();
  } catch (error) {
    process.stderr.write(
      `${error instanceof Error ? error.message : 'hotfix validation failed'}\n`
    );
    process.exitCode = 1;
  }
}
