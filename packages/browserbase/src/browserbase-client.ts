import type {
  BrowserbaseDebugUrls,
  BrowserbaseSession,
  CreateSessionParams,
} from "./types.js";

const BROWSERBASE_API_URL = "https://api.browserbase.com";

/**
 * Lightweight HTTP client for the Browserbase REST API.
 * Uses plain fetch — no Node.js dependencies, Workers-compatible.
 */
export class BrowserbaseClient {
  private readonly apiKey: string;
  private readonly baseUrl: string;

  constructor(apiKey: string, baseUrl = BROWSERBASE_API_URL) {
    this.apiKey = apiKey;
    this.baseUrl = baseUrl;
  }

  /** Create a new browser session. */
  async createSession(params: CreateSessionParams): Promise<BrowserbaseSession> {
    const res = await fetch(`${this.baseUrl}/v1/sessions`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify(params),
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Browserbase createSession failed (${res.status}): ${text}`);
    }
    return res.json() as Promise<BrowserbaseSession>;
  }

  /** Get live debug/viewer URLs for a running session. */
  async getDebugUrls(sessionId: string): Promise<BrowserbaseDebugUrls> {
    const res = await fetch(`${this.baseUrl}/v1/sessions/${sessionId}/debug`, {
      headers: this.headers(),
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Browserbase getDebugUrls failed (${res.status}): ${text}`);
    }
    return res.json() as Promise<BrowserbaseDebugUrls>;
  }

  /** Gracefully release a session (stops billing). */
  async releaseSession(sessionId: string): Promise<void> {
    const res = await fetch(`${this.baseUrl}/v1/sessions/${sessionId}`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify({ status: "REQUEST_RELEASE" }),
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Browserbase releaseSession failed (${res.status}): ${text}`);
    }
  }

  /** Create a persistent browser context (profile). Returns the context ID. */
  async createContext(projectId?: string): Promise<string> {
    const body: Record<string, string> = {};
    if (projectId) {
      body.projectId = projectId;
    }
    const res = await fetch(`${this.baseUrl}/v1/contexts`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Browserbase createContext failed (${res.status}): ${text}`);
    }
    const data = (await res.json()) as { id: string };
    return data.id;
  }

  private headers(): Record<string, string> {
    return {
      "X-BB-API-Key": this.apiKey,
      "Content-Type": "application/json",
    };
  }
}
