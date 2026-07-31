export function openAuthenticatedWebSocket(url: string, accessToken: string): WebSocket {
  const endpoint = new URL(url);
  endpoint.searchParams.delete('token');
  return new WebSocket(endpoint, ['ivekit.v1', `ivekit.jwt.${accessToken}`]);
}
