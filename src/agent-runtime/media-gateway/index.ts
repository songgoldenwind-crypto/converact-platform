/**
 * Default media gateway registry — wires up the available gateways.
 *
 * webrtc:   active (agents + H5 customers connect directly via token)
 * sip_volte: planned (4G VoLTE video via RustPBX → livekit-sip bridge)
 *
 * A singleton is exposed so orchestration code shares one registry, with a
 * reset hook for tests.
 */
import { MediaGatewayRegistry } from './media-gateway-registry.js';
import { WEBRTC_GATEWAY_DEFINITION, createWebRtcGateway } from './adapters/webrtc-gateway.js';
import { SIP_VOLTE_GATEWAY_DEFINITION, createSipVolteGateway } from './adapters/sip-volte-gateway.js';

export * from './media-gateway-registry.js';

export function createDefaultMediaGatewayRegistry(): MediaGatewayRegistry {
  const registry = new MediaGatewayRegistry();
  registry.register(WEBRTC_GATEWAY_DEFINITION, createWebRtcGateway());
  registry.register(SIP_VOLTE_GATEWAY_DEFINITION, createSipVolteGateway());
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
