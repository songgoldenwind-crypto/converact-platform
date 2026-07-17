import {
  createRustDeskOwnerBindingHttpServer,
  RustDeskOwnerBindingRegistry,
  rustDeskOwnerBindingCheckpointFromFile
} from '../src/agent-runtime/ivekit/placement/rustdesk-owner-binding.js';

const host = String(process.env.OPC_IVEKIT_RUSTDESK_OWNER_BINDING_HOST || '127.0.0.1').trim();
const port = Number(process.env.OPC_IVEKIT_RUSTDESK_OWNER_BINDING_PORT || 3211);
const nodeId = String(process.env.OPC_IVEKIT_COMPONENT_NODE_ID || '').trim();
const serviceToken = String(process.env.OPC_IVEKIT_RUSTDESK_OWNER_BINDING_TOKEN || '').trim();
const checkpointPath = String(
  process.env.OPC_IVEKIT_RUSTDESK_OWNER_BINDING_CHECKPOINT ||
  '/var/lib/ivekit-rustdesk-owner/bindings.json'
).trim();

const registry = new RustDeskOwnerBindingRegistry({
  node_id: nodeId,
  max_bindings: Number(process.env.OPC_IVEKIT_RUSTDESK_OWNER_BINDING_LIMIT || 4_096),
  claimed_ttl_ms: Number(
    process.env.OPC_IVEKIT_RUSTDESK_OWNER_BINDING_CLAIMED_TTL_MS || 120_000
  ),
  checkpoint: rustDeskOwnerBindingCheckpointFromFile(checkpointPath)
});
const server = createRustDeskOwnerBindingHttpServer({
  registry,
  service_token: serviceToken,
  checkpoint_path: checkpointPath
});

server.listen(port, host, () => {
  console.log(`[ivekit-rustdesk-owner-binding] listening on ${host}:${port} node=${nodeId}`);
});

const shutdown = () => server.close(() => process.exit(0));
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
