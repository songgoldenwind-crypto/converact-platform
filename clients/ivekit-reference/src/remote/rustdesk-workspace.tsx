import {
  createIveKitRustDeskHttpClient,
  createIveKitRustDeskLedSdk,
  type IveKitRustDeskClient
} from '@opc/ivekit-sdk';
import { useMemo, type ComponentProps } from 'react';

import { RustDeskLaunchPanel } from './rustdesk-launch-panel.js';

type RustDeskWorkspaceProps = Omit<
  ComponentProps<typeof RustDeskLaunchPanel>,
  'client'
> & {
  baseUrl: string;
  tenantId: string;
  accessToken: string;
};

export function RustDeskWorkspace({
  baseUrl,
  tenantId,
  accessToken,
  ...panelProps
}: RustDeskWorkspaceProps) {
  const client = useMemo<IveKitRustDeskClient | null>(() => {
    if (!baseUrl || !tenantId || !accessToken) return null;
    const http = createIveKitRustDeskHttpClient({
      baseUrl,
      tenantId,
      accessToken
    });
    return {
      ...http,
      ...createIveKitRustDeskLedSdk({ tenantId, client: http })
    };
  }, [accessToken, baseUrl, tenantId]);

  return <RustDeskLaunchPanel {...panelProps} client={client} />;
}
