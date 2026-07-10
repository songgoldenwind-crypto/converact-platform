import { useCallback, useSyncExternalStore } from 'react';
import { clearAuthSession, getTenantId, getUserId, saveAuthSession, type AuthSession } from '../api/client';

function getSnapshot(): boolean {
  return !!(localStorage.getItem('opc_token') || localStorage.getItem('opc_api_key'));
}

function subscribe(callback: () => void) {
  window.addEventListener('storage', callback);
  window.addEventListener('auth-change', callback);
  return () => {
    window.removeEventListener('storage', callback);
    window.removeEventListener('auth-change', callback);
  };
}

export function useAuth() {
  const isAuthenticated = useSyncExternalStore(subscribe, getSnapshot);

  const loginWithSession = useCallback((session: AuthSession) => {
    saveAuthSession(session);
  }, []);

  const loginWithApiKey = useCallback((key: string) => {
    localStorage.setItem('opc_api_key', key);
    window.dispatchEvent(new Event('auth-change'));
  }, []);

  const logout = useCallback(() => {
    localStorage.removeItem('opc_api_key');
    clearAuthSession();
  }, []);

  const tenantId = getTenantId();
  const userId = getUserId();
  const tenantName = localStorage.getItem('opc_tenant_name') || '';
  const userEmail = localStorage.getItem('opc_user_email') || '';

  return {
    isAuthenticated,
    loginWithSession,
    loginWithApiKey,
    logout,
    tenantId,
    userId,
    tenantName,
    userEmail
  };
}
