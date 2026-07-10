import type { ServerResponse } from 'node:http';

export type SseEventType =
  | 'queue_update'
  | 'call_assigned'
  | 'call_ended'
  | 'transcript'
  | 'transfer_request'
  | 'system';

type SSEClient = {
  seatId: string;
  tenantId: string;
  response: ServerResponse;
  lastEventId: number;
};

class SSEManager {
  private readonly clients = new Map<string, SSEClient>();

  register(seatId: string, tenantId: string, res: ServerResponse): void {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no'
    });
    res.write(': connected\n\n');
    this.clients.set(seatId, { seatId, tenantId, response: res, lastEventId: 0 });
    res.on('close', () => this.clients.delete(seatId));
  }

  send(seatId: string, event: SseEventType, data: unknown): void {
    const client = this.clients.get(seatId);
    if (!client || client.response.writableEnded) {
      this.clients.delete(seatId);
      return;
    }
    const eventId = ++client.lastEventId;
    client.response.write(`id: ${eventId}\nevent: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  }

  broadcast(tenantId: string, event: SseEventType, data: unknown): void {
    for (const client of this.clients.values()) {
      if (client.tenantId === tenantId) {
        this.send(client.seatId, event, data);
      }
    }
  }
}

export const sseManager = new SSEManager();
