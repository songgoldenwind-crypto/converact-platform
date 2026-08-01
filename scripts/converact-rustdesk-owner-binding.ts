import { resolveFabricEnv } from '../src/config/converact-env.js';
import {
  createRustDeskOwnerBindingHttpServer,
  RustDeskOwnerBindingRegistry,
  rustDeskOwnerBindingCheckpointFromFile
} from '../src/agent-runtime/converact/placement/rustdesk-owner-binding.js';

const host = String(resolveFabricEnv(process.env, 'RUSTDESK_OWNER_BINDING_HOST') || '127.0.0.1').trim();
const port = Number(resolveFabricEnv(process.env, 'RUSTDESK_OWNER_BINDING_PORT') || 3211);
const nodeId = String(resolveFabricEnv(process.env, 'COMPONENT_NODE_ID') || '').trim();
const serviceToken = String(resolveFabricEnv(process.env, 'RUSTDESK_OWNER_BINDING_TOKEN') || '').trim();
const checkpointPath = String(
  resolveFabricEnv(process.env, 'RUSTDESK_OWNER_BINDING_CHECKPOINT') ||
  '/var/lib/ivekit-rustdesk-owner/bindings.json'
).trim();

const registry = new RustDeskOwnerBindingRegistry({
  node_id: nodeId,
  max_bindings: Number(resolveFabricEnv(process.env, 'RUSTDESK_OWNER_BINDING_LIMIT') || 4_096),
  claimed_ttl_ms: Number(
    resolveFabricEnv(process.env, 'RUSTDESK_OWNER_BINDING_CLAIMED_TTL_MS') || 120_000
  ),
  checkpoint: rustDeskOwnerBindingCheckpointFromFile(checkpointPath)
});
const server = createRustDeskOwnerBindingHttpServer({
  registry,
  service_token: serviceToken,
  checkpoint_path: checkpointPath
});

server.listen(port, host, () => {
  console.log(`[converact-rustdesk-owner-binding] listening on ${host}:${port} node=${nodeId}`);
});

const shutdown = () => server.close(() => process.exit(0));
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
