import type { VoiceParkingRepository } from './ports.js';
import type { VoiceCallCommand } from './types.js';

export class VoiceParkingCommandReconciler {
  constructor(private readonly parking: VoiceParkingRepository) {}

  async reconcile(command: VoiceCallCommand): Promise<{
    state: 'succeeded' | 'failed' | 'unknown';
  } | null> {
    if (command.kind !== 'park' && command.kind !== 'pickup') return null;
    const slot = command.kind === 'park'
      ? await this.parking.getByParkCommand(command.tenant_id, command.id)
      : await this.parking.getByPickupCommand(command.tenant_id, command.id);
    if (!slot) return { state: 'unknown' };
    if (command.kind === 'park') {
      if (slot.state === 'parked' || slot.state === 'retrieving' || slot.state === 'released') {
        return { state: 'succeeded' };
      }
      if (slot.state === 'failed' || slot.state === 'expired') return { state: 'failed' };
      return { state: 'unknown' };
    }
    if (slot.state === 'released') return { state: 'succeeded' };
    if (slot.state === 'parked' && slot.pickup_command_id === command.id) return { state: 'failed' };
    return { state: 'unknown' };
  }
}
