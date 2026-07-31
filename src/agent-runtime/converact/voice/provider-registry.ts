import { VoiceError } from './errors.js';
import type { VoiceProviderAdapter, VoiceProviderFactory } from './ports.js';
import type { VoiceAdapter, VoiceDeploymentProfile } from './types.js';

export type VoiceProviderPurpose = 'preflight' | 'execute';

const M2_ADAPTERS = new Set<VoiceAdapter>(['controlled', 'rustpbx', 'livekit_sip']);

export class VoiceProviderRegistry {
  readonly #factories = new Map<VoiceAdapter, VoiceProviderFactory>();

  constructor(factories: Partial<Record<VoiceAdapter, VoiceProviderFactory>> = {}) {
    for (const [adapter, factory] of Object.entries(factories)) {
      if (!M2_ADAPTERS.has(adapter as VoiceAdapter) || !factory) {
        throw new VoiceError({ code: 'validation_failed', status: 500 });
      }
      this.#factories.set(adapter as VoiceAdapter, factory);
    }
  }

  register(adapter: Extract<VoiceAdapter, 'controlled' | 'rustpbx' | 'livekit_sip'>, factory: VoiceProviderFactory): void {
    if (this.#factories.has(adapter)) throw new VoiceError({ code: 'validation_failed', status: 500 });
    this.#factories.set(adapter, factory);
  }

  async create(
    profile: VoiceDeploymentProfile,
    options: { purpose?: VoiceProviderPurpose } = {}
  ): Promise<VoiceProviderAdapter> {
    const purpose = options.purpose ?? 'execute';
    if (profile.status === 'archived' || (purpose === 'execute' && profile.status === 'disabled')) {
      throw new VoiceError({ code: 'capability_unavailable', status: 409 });
    }
    const factory = this.#factories.get(profile.adapter);
    if (!factory) throw new VoiceError({ code: 'capability_unavailable', status: 501 });
    return factory.create(profile);
  }
}
