import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { act, cleanup, render, waitFor } from '@testing-library/react';
import type { IveKitBusinessContext, IveKitClient } from '@opc/ivekit-sdk';

import { installTestDom } from '../test-dom.js';
import { useBusinessContext, type BusinessRefSelection } from './use-business-context.js';

let closeDom: () => void;
before(() => { closeDom = installTestDom(); });
after(() => { cleanup(); closeDom?.(); });

test('business context suppresses an old response after the selected reference changes', async () => {
  const pending = new Map<string, (value: IveKitBusinessContext) => void>();
  const client = {
    context: {
      getByBusinessRef: (ref: BusinessRefSelection) => new Promise<IveKitBusinessContext>((resolve) => {
        pending.set(ref.id, resolve);
      })
    }
  } as IveKitClient;
  const view = render(<Harness client={client} businessRef={{ type: 'service_order', id: 'SO-A' }} />);
  await waitFor(() => assert.ok(pending.has('SO-A')));
  view.rerender(<Harness client={client} businessRef={{ type: 'service_order', id: 'SO-B' }} />);
  await waitFor(() => assert.ok(pending.has('SO-B')));

  await act(async () => pending.get('SO-A')?.(context('SO-A')));
  assert.equal(view.container.textContent, 'none');
  await act(async () => pending.get('SO-B')?.(context('SO-B')));
  await waitFor(() => assert.equal(view.container.textContent, 'SO-B'));
});

function Harness(props: { client: IveKitClient; businessRef: BusinessRefSelection }) {
  const result = useBusinessContext(props.client, props.businessRef);
  return <span>{result.context?.business_ref.id || 'none'}</span>;
}

function context(id: string): IveKitBusinessContext {
  return {
    tenant_id: 'tenant-1',
    business_ref: { type: 'service_order', id },
    viewer: { identity: 'agent-1', system: false },
    capabilities: { chat: true, media: false, remote_assistance: false },
    chat: { count: 0, sessions: [] },
    media: { count: 0, calls: [] },
    remote_assistance: { count: 0, sessions: [], devices: [] }
  };
}
