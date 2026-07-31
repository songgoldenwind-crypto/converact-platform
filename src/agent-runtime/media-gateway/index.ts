/**
 * Default media gateway registry — wires up the available gateways.
 *
 * webrtc:   active (agents + H5 customers connect directly via token)
 * sip_volte: active only after explicit, complete production configuration
 *
 * A singleton is exposed so orchestration code shares one registry, with a
 * reset hook for tests.
 */
import { MediaGatewayRegistry } from './media-gateway-registry.js';
import { WEBRTC_GATEWAY_DEFINITION, createWebRtcGateway } from './adapters/webrtc-gateway.js';
import {
  createSipVolteGateway,
  createSipVolteGatewayDefinition,
  resolveSipVolteGatewayConfiguration
} from './adapters/sip-volte-gateway.js';

export * from './media-gateway-registry.js';
export * from './adapters/sip-volte-gateway.js';

export function createDefaultMediaGatewayRegistry(
  env: NodeJS.ProcessEnv = process.env
): MediaGatewayRegistry {
  const registry = new MediaGatewayRegistry();
  const sipVolte = resolveSipVolteGatewayConfiguration(env);
  registry.register(WEBRTC_GATEWAY_DEFINITION, createWebRtcGateway());
  registry.register(createSipVolteGatewayDefinition(sipVolte), createSipVolteGateway(sipVolte));
  return registry;
}

let sharedRegistry: MediaGatewayRegistry | null = null;

export function getMediaGatewayRegistry(): MediaGatewayRegistry {
  if (!sharedRegistry) {
    sharedRegistry = createDefaultMediaGatewayRegistry();
  }
  return sharedRegistry;
}

/** Test hook: reset the shared registry (or inject a custom one). */
export function resetMediaGatewayRegistryForTests(registry: MediaGatewayRegistry | null): void {
  sharedRegistry = registry;
}
