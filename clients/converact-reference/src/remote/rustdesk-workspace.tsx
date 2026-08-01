import {
  createConveractFabricRustDeskHttpClient,
  createConveractFabricRustDeskLedSdk,
  type ConveractFabricRustDeskClient
} from '@converact/sdk';
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
  const client = useMemo<ConveractFabricRustDeskClient | null>(() => {
    if (!baseUrl || !tenantId || !accessToken) return null;
    const http = createConveractFabricRustDeskHttpClient({
      baseUrl,
      tenantId,
      accessToken
    });
    return {
      ...http,
      ...createConveractFabricRustDeskLedSdk({ tenantId, client: http })
    };
  }, [accessToken, baseUrl, tenantId]);

  return <RustDeskLaunchPanel {...panelProps} client={client} />;
}
