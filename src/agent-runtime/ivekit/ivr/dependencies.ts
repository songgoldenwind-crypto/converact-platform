import type { IvrFlowGraph, IvrNodeBase, IvrNodeType } from './graph-types.js';

export interface IvrSubflowDependency {
  flow_id: string;
  version?: number;
}

export interface IvrDependencyManifest {
  node_types: IvrNodeType[];
  audio_assets: string[];
  time_groups: string[];
  region_groups: string[];
  ring_groups: string[];
  queues: string[];
  subflows: IvrSubflowDependency[];
  webhook_refs: string[];
  knowledge_profiles: string[];
  ai_profiles: string[];
  provider_profile_ids: string[];
  media_capabilities: string[];
  voice_capabilities: string[];
}

export function extractIvrDependencies(
  graph: IvrFlowGraph,
  includedNodeIds?: ReadonlySet<string>
): IvrDependencyManifest {
  const nodes = includedNodeIds
    ? graph.nodes.filter((node) => includedNodeIds.has(node.id))
    : graph.nodes;
  const manifest = emptyManifest();
  const subflows = new Map<string, IvrSubflowDependency>();
  for (const node of nodes) {
    add(manifest.node_types, node.type);
    collectReferences(node, manifest, subflows);
    collectCapabilities(node.type, manifest);
  }
  manifest.subflows = [...subflows.values()].sort((left, right) => (
    `${left.flow_id}:${left.version ?? ''}`.localeCompare(`${right.flow_id}:${right.version ?? ''}`)
  ));
  for (const value of Object.values(manifest)) {
    if (Array.isArray(value) && value !== manifest.subflows) value.sort(compareStrings);
  }
  return manifest;
}

function collectReferences(
  node: IvrNodeBase,
  manifest: IvrDependencyManifest,
  subflows: Map<string, IvrSubflowDependency>
): void {
  const data = node.data;
  addFrom(data, ['audio_asset_id', 'audioAssetId'], manifest.audio_assets);
  addFrom(data, ['time_group_id', 'timeGroupId', 'scheduleId'], manifest.time_groups);
  addFrom(data, ['region_group_id', 'regionGroupId'], manifest.region_groups);
  addFrom(data, ['ring_group_id', 'ringGroupId'], manifest.ring_groups);
  addFrom(data, ['queue_id', 'queueId'], manifest.queues);
  addFrom(data, ['webhook_ref', 'webhookRef', 'url_ref', 'urlRef'], manifest.webhook_refs);
  addFrom(data, ['knowledge_profile_id', 'knowledgeProfileId'], manifest.knowledge_profiles);
  addFrom(data, ['ai_profile_id', 'aiProfileId'], manifest.ai_profiles);
  addFrom(data, ['provider_profile_id', 'providerProfileId'], manifest.provider_profile_ids);
  if (node.type === 'subflow') {
    const flowId = reference(data, ['flow_id', 'flowId']);
    const version = positiveInteger(data.flow_version ?? data.flowVersion);
    if (flowId) subflows.set(`${flowId}:${version ?? ''}`, {
      flow_id: flowId,
      ...(version === undefined ? {} : { version })
    });
  }
}

function collectCapabilities(type: IvrNodeType, manifest: IvrDependencyManifest): void {
  if (type === 'avatar_switch' || type === 'video_play' || type === 'screen_share' || type === 'visual_menu') {
    add(manifest.media_capabilities, type);
  }
  const voiceCapability: Partial<Record<IvrNodeType, string>> = {
    play: 'play',
    menu: 'collect',
    collect: 'collect',
    survey: 'collect',
    flush_audio: 'flush_audio',
    transfer: 'transfer',
    sip: 'sip_transfer',
    disconnect: 'hangup',
    voicemail: 'recording',
    recording: 'recording',
    compliance: 'recording'
  };
  const capability = voiceCapability[type];
  if (capability) add(manifest.voice_capabilities, capability);
}

function emptyManifest(): IvrDependencyManifest {
  return {
    node_types: [], audio_assets: [], time_groups: [], region_groups: [], ring_groups: [],
    queues: [], subflows: [], webhook_refs: [], knowledge_profiles: [], ai_profiles: [],
    provider_profile_ids: [], media_capabilities: [], voice_capabilities: []
  };
}

function addFrom(data: Record<string, unknown>, keys: string[], output: string[]): void {
  const value = reference(data, keys);
  if (value) add(output, value);
}

function reference(data: Record<string, unknown>, keys: string[]): string {
  for (const key of keys) {
    const value = data[key];
    if (typeof value === 'string' && isReference(value)) return value;
  }
  return '';
}

function isReference(value: string): boolean {
  return value.length > 0 && value.length <= 256 && /^[A-Za-z0-9][A-Za-z0-9_.:/-]*$/.test(value);
}

function positiveInteger(value: unknown): number | undefined {
  return Number.isInteger(value) && Number(value) > 0 ? Number(value) : undefined;
}

function add<T extends string>(values: T[], value: T): void {
  if (!values.includes(value)) values.push(value);
}

function compareStrings(left: unknown, right: unknown): number {
  return String(left).localeCompare(String(right));
}
