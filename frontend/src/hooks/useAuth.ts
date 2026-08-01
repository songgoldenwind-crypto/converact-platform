import { useCallback, useSyncExternalStore } from 'react';
import { clearAuthSession, getTenantId, getUserId, saveAuthSession, type AuthSession } from '../api/client';
import { readAuthStorage, removeAuthStorage, writeAuthStorage } from '../auth-storage';

function getSnapshot(): boolean {
  return !!(readAuthStorage('token') || readAuthStorage('api_key'));
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
    writeAuthStorage('api_key', key);
    window.dispatchEvent(new Event('auth-change'));
  }, []);

  const logout = useCallback(() => {
    removeAuthStorage('api_key');
    clearAuthSession();
  }, []);

  const tenantId = getTenantId();
  const userId = getUserId();
  const tenantName = readAuthStorage('tenant_name') || '';
  const userEmail = readAuthStorage('user_email') || '';

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
