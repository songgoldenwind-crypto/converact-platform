import type { IveKitClient } from '@opc/ivekit-sdk';
import React from 'react';
import { IntelligenceSourcePanel } from './intelligence-source-panel.js';
import { ReviewQueue } from './review-queue.js';

export function QualityWorkspace(props: {
  client: IveKitClient;
  selectedSessionId: string;
  refreshVersion: number;
}) {
  return <div className="quality-workspace-pane">
    <ReviewQueue client={props.client} refreshVersion={props.refreshVersion} />
    <IntelligenceSourcePanel
      client={props.client}
      initialSessionId={props.selectedSessionId}
      refreshVersion={props.refreshVersion}
    />
  </div>;
}
