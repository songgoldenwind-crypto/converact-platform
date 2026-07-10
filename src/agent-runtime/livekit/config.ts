export interface LiveKitConfig {
  url: string | null;
  apiKey: string | null;
  apiSecret: string | null;
  sipBridgeTarget: string;
  webhookApiKey: string | null;
}

export function readLiveKitConfig(): LiveKitConfig {
  return {
    url: process.env.LIVEKIT_URL || process.env.OPC_LIVEKIT_URL || null,
    apiKey: process.env.LIVEKIT_API_KEY || process.env.OPC_LIVEKIT_API_KEY || null,
    apiSecret: process.env.LIVEKIT_API_SECRET || process.env.OPC_LIVEKIT_API_SECRET || null,
    sipBridgeTarget: process.env.LIVEKIT_SIP_BRIDGE_TARGET || 'sip:livekit-bridge@127.0.0.1:5061',
    webhookApiKey: process.env.LIVEKIT_API_KEY || process.env.OPC_LIVEKIT_API_KEY || null
  };
}

export function isLiveKitConfigured(config: LiveKitConfig = readLiveKitConfig()): boolean {
  return Boolean(config.url && config.apiKey && config.apiSecret);
}
