type WaitEntry = {
  resolve: (value: boolean) => void;
  timer: ReturnType<typeof setTimeout>;
};

export class DialerWaitRegistry {
  private readonly agentWaits = new Map<string, WaitEntry>();
  private readonly customerWaits = new Map<string, WaitEntry>();
  private readonly callAnswerWaits = new Map<string, WaitEntry>();

  waitForAgentJoin(roomName: string, timeoutMs: number): Promise<boolean> {
    return this.wait(this.agentWaits, roomName, timeoutMs);
  }

  waitForCustomerJoin(roomName: string, timeoutMs: number): Promise<boolean> {
    return this.wait(this.customerWaits, roomName, timeoutMs);
  }

  waitForCallAnswered(callId: string, timeoutMs: number): Promise<boolean> {
    return this.wait(this.callAnswerWaits, callId, timeoutMs);
  }

  notifyParticipantJoined(roomName: string, identity: string): void {
    const normalized = String(identity || '').toLowerCase();
    if (normalized.includes('ai-agent') || normalized.startsWith('agent_')) {
      this.resolve(this.agentWaits, roomName, true);
      return;
    }
    if (normalized.includes('customer') || normalized.startsWith('customer-')) {
      this.resolve(this.customerWaits, roomName, true);
    }
  }

  notifyCallState(callId: string, state: string): void {
    if (state === 'answered') this.resolve(this.callAnswerWaits, callId, true);
    if (state === 'hangup') {
      this.resolve(this.callAnswerWaits, callId, false);
    }
  }

  private wait(map: Map<string, WaitEntry>, key: string, timeoutMs: number): Promise<boolean> {
    const existing = map.get(key);
    if (existing) {
      clearTimeout(existing.timer);
      map.delete(key);
    }
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        map.delete(key);
        resolve(false);
      }, timeoutMs);
      map.set(key, { resolve, timer });
    });
  }

  private resolve(map: Map<string, WaitEntry>, key: string, value: boolean): void {
    const entry = map.get(key);
    if (!entry) return;
    clearTimeout(entry.timer);
    map.delete(key);
    entry.resolve(value);
  }

  /** Test-only: clear pending waits between cases. */
  resetForTests(): void {
    for (const map of [this.agentWaits, this.customerWaits, this.callAnswerWaits]) {
      for (const entry of map.values()) clearTimeout(entry.timer);
      map.clear();
    }
  }
}

export const dialerWaitRegistry = new DialerWaitRegistry();
