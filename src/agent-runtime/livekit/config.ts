export interface LiveKitConfig {
  url: string | null;
  publicUrl: string | null;
  apiKey: string | null;
  apiSecret: string | null;
  sipBridgeTarget: string;
  webhookApiKey: string | null;
  nodeEnv?: string;
}

export function readLiveKitConfig(env: NodeJS.ProcessEnv = process.env): LiveKitConfig {
  const url = value(env.LIVEKIT_URL || env.OPC_LIVEKIT_URL);
  const explicitPublicUrl = value(env.LIVEKIT_PUBLIC_URL || env.OPC_LIVEKIT_PUBLIC_URL);
  return {
    url,
    publicUrl: explicitPublicUrl || (env.NODE_ENV === 'production' ? null : url),
    apiKey: value(env.LIVEKIT_API_KEY || env.OPC_LIVEKIT_API_KEY),
    apiSecret: value(env.LIVEKIT_API_SECRET || env.OPC_LIVEKIT_API_SECRET),
    sipBridgeTarget: value(env.LIVEKIT_SIP_BRIDGE_TARGET) || 'sip:livekit-bridge@127.0.0.1:5061',
    webhookApiKey: value(env.LIVEKIT_API_KEY || env.OPC_LIVEKIT_API_KEY),
    nodeEnv: value(env.NODE_ENV) || undefined
  };
}

export function isLiveKitConfigured(config: LiveKitConfig = readLiveKitConfig()): boolean {
  return Boolean(config.url && config.apiKey && config.apiSecret);
}

export function isLiveKitBrowserJoinConfigured(
  config: LiveKitConfig = readLiveKitConfig(),
  nodeEnv: string | undefined = config.nodeEnv || process.env.NODE_ENV
): boolean {
  if (!isLiveKitConfigured(config)) return false;
  const publicUrl = resolveLiveKitPublicUrl(config, nodeEnv);
  return Boolean(publicUrl && isWebSocketUrl(publicUrl, nodeEnv === 'production'));
}

export function requireLiveKitPublicUrl(
  config: LiveKitConfig = readLiveKitConfig(),
  nodeEnv: string | undefined = config.nodeEnv || process.env.NODE_ENV
): string {
  const publicUrl = resolveLiveKitPublicUrl(config, nodeEnv);
  if (!publicUrl) {
    throw new Error('LIVEKIT_PUBLIC_URL or OPC_LIVEKIT_PUBLIC_URL is required for browser joins');
  }
  if (!isWebSocketUrl(publicUrl, nodeEnv === 'production')) {
    if (nodeEnv === 'production') {
      throw new Error('LIVEKIT_PUBLIC_URL must use wss:// in production');
    }
    throw new Error('LIVEKIT_PUBLIC_URL must use ws:// or wss://');
  }
  return publicUrl;
}

function resolveLiveKitPublicUrl(config: LiveKitConfig, nodeEnv: string | undefined): string | null {
  if (config.publicUrl) return config.publicUrl;
  return nodeEnv === 'production' ? null : config.url;
}

function isWebSocketUrl(value: string, requireSecure: boolean): boolean {
  try {
    const protocol = new URL(value).protocol;
    return requireSecure ? protocol === 'wss:' : protocol === 'ws:' || protocol === 'wss:';
  } catch {
    return false;
  }
}

function value(input: string | undefined): string | null {
  return String(input || '').trim() || null;
}
