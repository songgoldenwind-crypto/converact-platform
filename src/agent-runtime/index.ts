import { resolveBrandEnv } from '../config/converact-env.js';
import { ApprovalPolicy } from './approval/approval-policy.js';
import { AIWorkerClient } from './ai/ai-worker-client.js';
import { ApprovalQueue } from './approval/approval-queue.js';
import { ChannelAdapterRegistry, registerDefaultChannelAdapters } from './channels/channel-adapter-registry.js';
import { ContextBuilder } from './context/context-builder.js';
import { EvalRunner } from './eval/eval-runner.js';
import { EventBus } from './events/event-bus.js';
import { registerBusinessTools } from './business-tools.js';
import { GeoRoutingStore } from './geo/geo-routing-store.js';
import { GeoStore } from './geo/geo-store.js';
import { registerGeoRoutingTools } from './geo-routing-tools.js';
import { registerGeoTools } from './geo-tools.js';
import { HookManager } from './hooks/hook-manager.js';
import { AdapterRegistry, registerDefaultAdapters } from './integrations/adapter-registry.js';
import { IntegrationConfigStore } from './integrations/integration-config-store.js';
import { IntegrationCatalog } from './integrations/integration-catalog.js';
import { registerIntegrationTools } from './integrations/integration-tools.js';
import { ProviderRegistryStore } from './integrations/provider-registry-store.js';
import { McpServerStore } from './mcp/mcp-server-store.js';
import { registerMcpTools } from './mcp/mcp-tools.js';
import { KnowledgeWikiStore } from './knowledge/wiki-store.js';
import { registerKnowledgeWikiTools } from './knowledge/wiki-tools.js';
import { ResearchStore } from './research/research-store.js';
import { registerResearchTools } from './research/research-tools.js';
import { registerDefaultAgents } from './defaults.js';
import { MemoryPromoter } from './memory/memory-promoter.js';
import { MemoryStore } from './memory/memory-store.js';
import { registerMemoryTools } from './memory/memory-tools.js';
import { registerTranscriptHooks } from './memory/transcript-hooks.js';
import { TranscriptStore } from './memory/transcript-store.js';
import { MemoryMaintenance } from './memory/memory-maintenance.js';
import { MemoryWriteback } from './memory/memory-writeback.js';
import { SidecarHealthChecker } from './ops/sidecar-health.js';
import { registerOpsTools } from './ops-tools.js';
import { TenantSkillStore } from './skills/tenant-skill-store.js';
import { registerTenantSkillTools } from './skills/tenant-skill-tools.js';
import { DryRunModelAdapter } from './model/dry-run-adapter.js';
import { ModelGateway } from './model/model-gateway.js';
import { ProviderModelAdapter } from './model/provider-model-adapter.js';
import { registerTraceHooks, TraceStore } from './observability/trace-store.js';
import { PlaybookRouter } from './commander/playbook-router.js';
import { CommanderService } from './commander/commander-service.js';
import { QuotaStore, registerQuotaHooks } from './quota/quota-store.js';
import { AgentRegistry } from './registry/agent-registry.js';
import { CheckpointManager, registerCheckpointHooks } from './recovery/checkpoint-manager.js';
import { SideEffectTracker, registerSideEffectHooks } from './recovery/side-effect-tracker.js';
import { RbacStore, registerRbacHooks } from './security/rbac-store.js';
import { QualityGateRegistry, registerDefaultQualityGates } from './quality/quality-gate-registry.js';
import { TriggerRunner } from './scheduler/trigger-runner.js';
import { ArtifactStore } from './stores/artifact-store.js';
import { registerArtifactTools } from './stores/artifact-tools.js';
import { RunStore } from './stores/run-store.js';
import { ToolExecutor } from './tools/tool-executor.js';
import { ToolRegistry } from './tools/tool-registry.js';
import { VoiceMediaClient } from './voice/voice-media-client.js';
import { VoiceStore } from './voice/voice-store.js';
import { registerVoiceTools } from './voice-tools.js';
import { HarnessRuntime } from './harness-runtime.js';
import { DagEngine } from './workflow/dag-engine.js';
import { ScopeLockManager } from './workflow/scope-locks.js';
import type { JsonRecord } from './integrations/provider-runtime-types.js';

export function createHarness(db: unknown, options: JsonRecord = {}) {
  const runStore = new RunStore(db);
  const hookManager = options.hookManager || new HookManager();
  const checkpointManager = new CheckpointManager(db, runStore);
  registerCheckpointHooks(hookManager, checkpointManager);
  const sideEffectTracker = new SideEffectTracker(db, runStore);
  registerSideEffectHooks(hookManager, sideEffectTracker);
  const rbacStore = new RbacStore(db, runStore);
  registerRbacHooks(hookManager, rbacStore);
  const quotaStore = new QuotaStore(db, runStore);
  registerQuotaHooks(hookManager, quotaStore);
  const traceStore = new TraceStore(db);
  registerTraceHooks(hookManager, traceStore);
  const artifactStore = new ArtifactStore(db, runStore, hookManager);
  const approvalQueue = new ApprovalQueue(db, runStore);
  const approvalPolicy = new ApprovalPolicy(options.approvalPolicy);
  const toolRegistry = new ToolRegistry();
  const toolExecutor = new ToolExecutor({
    registry: toolRegistry,
    approvalPolicy,
    approvalQueue,
    runStore,
    hookManager
  });
  const agentRegistry = new AgentRegistry(db);
  const memoryStore = new MemoryStore(db, runStore);
  const transcriptStore = new TranscriptStore(db, runStore);
  const memoryPromoter = new MemoryPromoter(db, memoryStore, runStore);
  const integrationCatalog = new IntegrationCatalog();
  const integrationConfigStore = new IntegrationConfigStore(db, runStore);
  const providerGatewayClient = options.providerGatewayClient || null;
  const aiWorkerClient = options.aiWorkerClient || new AIWorkerClient(options.aiWorker || {});
  const voiceMediaClient = options.voiceMediaClient || new VoiceMediaClient(options.voiceMedia || {});
  const adapterRegistry = new AdapterRegistry();
  registerDefaultAdapters(adapterRegistry);
  const providerRegistryStore = new ProviderRegistryStore({
    db,
    integrationCatalog,
    adapterRegistry,
    integrationConfigStore,
    runStore
  });
  const tenantSkillStore = new TenantSkillStore({ db, integrationCatalog, runStore });
  const mcpServerStore = new McpServerStore({
    db,
    integrationCatalog,
    adapterRegistry,
    integrationConfigStore,
    runStore
  });
  const contextBuilder = new ContextBuilder({
    memoryStore,
    skillStore: tenantSkillStore,
    providerStore: providerRegistryStore,
    runStore,
    hookManager,
    ...(options.contextBuilder || {})
  });
  const scopeLocks = new ScopeLockManager(db);
  const eventBus = new EventBus(db, runStore);
  const modelGateway = new ModelGateway({
    runStore,
    hookManager,
    providerRegistryStore,
    ...(options.modelGateway || {})
  });
  modelGateway.registerAdapter('dry_run', new DryRunModelAdapter(options.dryRunModel || {}));
  modelGateway.registerAdapter('openai-compatible', new ProviderModelAdapter(providerRegistryStore, 'openai-compatible'));
  const memoryMaintenance = new MemoryMaintenance(db, memoryStore, { modelGateway });
  const memoryWriteback = new MemoryWriteback(db, memoryStore, memoryPromoter, modelGateway);
  registerTranscriptHooks(hookManager, transcriptStore, db, memoryMaintenance);
  const wikiStore = new KnowledgeWikiStore(db, runStore);
  const researchStore = new ResearchStore({
    db,
    providerRegistryStore,
    wikiStore,
    artifactStore,
    runStore
  });
  const geoStore = new GeoStore({
    db,
    artifactStore,
    modelGateway,
    providerRegistryStore,
    integrationConfigStore,
    runStore,
    aiWorkerClient
  });
  const geoRoutingStore = new GeoRoutingStore({
    db,
    geoStore,
    artifactStore,
    runStore
  });
  const voiceStore = new VoiceStore(
    db,
    runStore,
    integrationConfigStore,
    voiceMediaClient
  );
  const sidecarHealthChecker = new SidecarHealthChecker({
    integrationConfigStore,
    providerGatewayClient: providerGatewayClient || { gatewayUrl: resolveBrandEnv(process.env, 'PROVIDER_GATEWAY_URL') || null },
    aiWorkerClient,
    voiceMediaClient
  });
  const channelAdapterRegistry = new ChannelAdapterRegistry();
  registerDefaultChannelAdapters(channelAdapterRegistry);
  const qualityGateRegistry = new QualityGateRegistry();
  registerDefaultQualityGates(qualityGateRegistry);

  registerBusinessTools(toolRegistry, db, channelAdapterRegistry, integrationConfigStore);
  registerArtifactTools(toolRegistry, artifactStore);
  registerIntegrationTools(toolRegistry, integrationCatalog, adapterRegistry, integrationConfigStore, providerRegistryStore);
  registerTenantSkillTools(toolRegistry, tenantSkillStore);
  registerMcpTools(toolRegistry, mcpServerStore);
  registerVoiceTools(toolRegistry, db, channelAdapterRegistry, voiceStore, providerRegistryStore);
  registerKnowledgeWikiTools(toolRegistry, wikiStore, { modelGateway, artifactStore });
  registerResearchTools(toolRegistry, researchStore);
  registerGeoTools(toolRegistry, geoStore);
  registerMemoryTools(toolRegistry, { memoryStore, memoryPromoter, transcriptStore, memoryMaintenance, memoryWriteback });
  registerOpsTools(toolRegistry, sidecarHealthChecker, {
    db,
    voiceStore,
    quotaStore,
    providerRegistryStore,
    geoRoutingStore
  });
  registerDefaultAgents(agentRegistry);

  const runtime = new HarnessRuntime({
    agentRegistry,
    toolExecutor,
    artifactStore,
    runStore,
    contextBuilder,
    scopeLocks,
    qualityGateRegistry
  });
  const dagEngine = new DagEngine({
    runStore,
    toolExecutor,
    artifactStore,
    playbookRunner: (playbookInput) => runtime.runPlaybook(playbookInput)
  });
  const playbookRouter = new PlaybookRouter(agentRegistry);
  const triggerRunner = new TriggerRunner({ db, runtime, playbookRouter, runStore });
  registerGeoRoutingTools(toolRegistry, geoRoutingStore, toolExecutor, triggerRunner, approvalQueue);
  const commander = new CommanderService({ playbookRouter, runtime, dagEngine, toolRegistry, modelGateway });
  const evalRunner = new EvalRunner({ runtime, qualityGateRegistry, agentRegistry });

  return {
    runtime,
    dagEngine,
    hookManager,
    agentRegistry,
    toolRegistry,
    toolExecutor,
    runStore,
    artifactStore,
    checkpointManager,
    sideEffectTracker,
    rbacStore,
    quotaStore,
    traceStore,
    approvalQueue,
    approvalPolicy,
    contextBuilder,
    memoryStore,
    transcriptStore,
    memoryPromoter,
    modelGateway,
    wikiStore,
    researchStore,
    geoStore,
    geoRoutingStore,
    voiceStore,
    eventBus,
    integrationCatalog,
    integrationConfigStore,
    providerRegistryStore,
    tenantSkillStore,
    mcpServerStore,
    adapterRegistry,
    channelAdapterRegistry,
    playbookRouter,
    commander,
    triggerRunner,
    evalRunner,
    qualityGateRegistry,
    scopeLocks,
    sidecarHealthChecker
  };
}
