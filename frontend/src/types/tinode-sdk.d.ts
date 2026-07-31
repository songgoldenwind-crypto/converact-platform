declare module 'tinode-sdk' {
  export interface TinodeConfig {
    host: string;
    secure: boolean;
    appName: string;
    apiKey: string;
    transport: 'ws' | 'lp';
    persist: boolean;
  }

  export class Tinode {
    constructor(config: TinodeConfig);
    onConnect?: () => void;
    onDisconnect?: (error?: unknown) => void;
    connect(): Promise<unknown>;
    loginToken(token: string): Promise<unknown>;
    getTopic(name: string): unknown;
    disconnect(): void;
  }

  const sdk: { Tinode: typeof Tinode };
  export default sdk;
}
