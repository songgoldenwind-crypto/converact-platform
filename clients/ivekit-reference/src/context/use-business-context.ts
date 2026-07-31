import type { IveKitBusinessContext, IveKitHttpSdk } from '@opc/ivekit-sdk';
import { useCallback, useEffect, useRef, useState } from 'react';

export interface BusinessRefSelection {
  type: string;
  id: string;
}

export function useBusinessContext(
  client: IveKitHttpSdk | null,
  businessRef: BusinessRefSelection | null
) {
  const [context, setContext] = useState<IveKitBusinessContext | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const requestId = useRef(0);

  const refresh = useCallback(async () => {
    if (!client || !businessRef) {
      setContext(null);
      setLoading(false);
      setError('');
      return;
    }
    const request = ++requestId.current;
    setLoading(true);
    try {
      const next = await client.context.getByBusinessRef(businessRef);
      if (request !== requestId.current) return;
      setContext(next);
      setError('');
    } catch (cause) {
      if (request !== requestId.current) return;
      setContext(null);
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      if (request === requestId.current) setLoading(false);
    }
  }, [businessRef?.id, businessRef?.type, client]);

  useEffect(() => {
    void refresh();
    return () => { requestId.current += 1; };
  }, [refresh]);

  const visibleContext = context && businessRef &&
    context.business_ref.type === businessRef.type && context.business_ref.id === businessRef.id
    ? context
    : null;
  return { context: visibleContext, loading, error, refresh };
}
