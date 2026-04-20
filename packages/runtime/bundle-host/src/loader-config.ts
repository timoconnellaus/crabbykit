/**
 * Shared Worker Loader config builder for every host → bundle dispatch
 * path. Centralizing the envelope decode + env composition here is the
 * single-helper enforcement of the "kept in sync convention" the
 * `bundle-runtime-surface` design called out: drift between dispatch
 * paths is now a structural impossibility.
 *
 * Every dispatch path currently routed through this helper:
 *   - POST /turn                     (bundlePromptHandler)
 *   - POST /alarm                    (dispatchLifecycle, bundle-runtime-surface)
 *   - POST /session-created          (dispatchLifecycle)
 *   - POST /client-event             (BundleDispatcher.dispatchClientEvent + dispatchLifecycle)
 *   - POST /http                     (dispatchHttp, bundle-http-and-ui-surface)
 *   - POST /action                   (dispatchAction)
 *   - POST /after-turn               (bundle-lifecycle-hooks)
 *   - POST /on-connect               (bundle-lifecycle-hooks)
 *   - POST /dispose                  (bundle-lifecycle-hooks, session-less)
 *   - POST /on-turn-end              (bundle-lifecycle-hooks)
 *   - POST /on-agent-end             (bundle-lifecycle-hooks, session-less)
 *   - POST /config-change            (bundle-config-namespaces)
 *   - POST /agent-config-change      (bundle-config-namespaces)
 *   - POST /config-namespace-get     (bundle-config-namespaces)
 *   - POST /config-namespace-set     (bundle-config-namespaces)
 *
 * Adding a new dispatch path means calling this helper from the new
 * site — anything else fails to land the required env projection
 * (`__BUNDLE_TOKEN`, `__BUNDLE_VERSION_ID`, optional
 * `__BUNDLE_PUBLIC_URL` / `__BUNDLE_ACTIVE_MODE`).
 */

import { type BundlePayload, decodeBundlePayload } from "./dispatcher.js";

const DEFAULT_COMPATIBILITY_DATE = "2025-12-01";
const DEFAULT_COMPATIBILITY_FLAGS = ["nodejs_compat"] as const;

export interface ComposedLoaderConfig {
  compatibilityDate: string;
  compatibilityFlags: string[];
  mainModule: string;
  modules: BundlePayload["modules"];
  env: Record<string, unknown>;
  globalOutbound: null;
}

/**
 * Compose the Worker Loader config record every dispatch path returns
 * from `loader.get(versionId, async () => …)`. Decodes the bundle
 * envelope, merges the projected host env with the per-turn token
 * fields, and pins `globalOutbound: null` so the bundle isolate has no
 * direct outbound network access.
 *
 * `extras` covers per-path env additions (e.g. the dispatcher's
 * `__BUNDLE_ACTIVE_MODE` / `__BUNDLE_PUBLIC_URL`). Already-present keys
 * in `extras` win over `projectedEnv` and reserved fields.
 */
export function composeWorkerLoaderConfig(args: {
  bytes: ArrayBuffer;
  projectedEnv: Record<string, unknown>;
  bundleToken: string;
  versionId: string;
  extras?: Record<string, unknown>;
}): ComposedLoaderConfig {
  const source = new TextDecoder().decode(args.bytes);
  const { mainModule, modules } = decodeBundlePayload(source);
  return {
    compatibilityDate: DEFAULT_COMPATIBILITY_DATE,
    compatibilityFlags: [...DEFAULT_COMPATIBILITY_FLAGS],
    mainModule,
    modules,
    env: {
      ...args.projectedEnv,
      __BUNDLE_TOKEN: args.bundleToken,
      __BUNDLE_VERSION_ID: args.versionId,
      ...(args.extras ?? {}),
    },
    globalOutbound: null,
  };
}
