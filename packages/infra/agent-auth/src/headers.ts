const HEADER_TOKEN = "x-agent-token";
const HEADER_ID = "x-agent-id";

export function setAuthHeaders(headers: Headers, token: string, senderId: string): void {
  headers.set(HEADER_TOKEN, token);
  headers.set(HEADER_ID, senderId);
}

export function getAuthFromRequest(request: Request): { token: string; senderId: string } | null {
  const token = request.headers.get(HEADER_TOKEN);
  const senderId = request.headers.get(HEADER_ID);
  if (!token || !senderId) return null;
  return { token, senderId };
}
