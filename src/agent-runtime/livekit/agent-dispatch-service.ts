import { AgentDispatchClient } from 'livekit-server-sdk';
import { isLiveKitConfigured, readLiveKitConfig } from './config.js';
import type { LiveKitConfig } from './config.js';

export function createAgentDispatchClient(config: LiveKitConfig = readLiveKitConfig()): AgentDispatchClient | null {
  if (!isLiveKitConfigured(config)) return null;
  const host = config.url!.replace(/^ws:/, 'http:').replace(/^wss:/, 'https:');
  return new AgentDispatchClient(host, config.apiKey!, config.apiSecret!);
}

export async function dispatchAiAgent(
  roomName: string,
  metadata: Record<string, unknown>,
  agentName = 'ai-agent',
  config: LiveKitConfig = readLiveKitConfig()
): Promise<boolean> {
  const client = createAgentDispatchClient(config);
  if (!client) return false;
  await client.createDispatch(roomName, agentName, {
    metadata: JSON.stringify(metadata)
  });
  return true;
}
