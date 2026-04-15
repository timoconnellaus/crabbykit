/**
 * Stub for environment-based API key resolution.
 * In Cloudflare Workers, API keys are passed directly via config, not env vars.
 */
export function getEnvApiKey(_provider: string): string | undefined {
  return undefined;
}
