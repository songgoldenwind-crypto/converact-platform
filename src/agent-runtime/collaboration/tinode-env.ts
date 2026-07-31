export function tinodeApiKeysDistinct(env: NodeJS.ProcessEnv): boolean {
  const browserKey = String(env.TINODE_API_KEY || '').trim();
  const rootKey = String(env.TINODE_ROOT_API_KEY || '').trim();
  return Boolean(browserKey && rootKey && browserKey !== rootKey);
}

export function tinodeServerApiKey(env: NodeJS.ProcessEnv): string {
  const browserKey = String(env.TINODE_API_KEY || '').trim();
  const rootKey = String(env.TINODE_ROOT_API_KEY || '').trim();
  if (browserKey && rootKey && browserKey === rootKey) {
    throw Object.assign(
      new Error('TINODE_API_KEY and TINODE_ROOT_API_KEY must be different'),
      { status: 503 }
    );
  }
  return rootKey;
}
