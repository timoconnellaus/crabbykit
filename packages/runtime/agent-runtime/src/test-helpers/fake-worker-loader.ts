/**
 * In-process fake {@link WorkerLoader} for bundle dispatch integration tests.
 *
 * Synthesizes a runnable entrypoint by evaluating the bundle source via
 * `new Function`. This avoids the data:text/javascript dynamic-import trick
 * used in `packages/runtime/agent-bundle/src/host/__tests__/bundle-dispatcher-integration.test.ts`,
 * which breaks under `@cloudflare/vitest-pool-workers` because vite-node's
 * module resolver intercepts `import("data:...")` before the workerd isolate
 * gets a chance to handle it (see `.../known-issues/#module-resolution`).
 *
 * The bundle source MUST follow the shape used by the fixtures in
 * `test/fixtures/bundle-sources.ts`: top-level `export default { fetch(...) }`.
 * The rewrite below is deliberately simple — it replaces the single
 * `export default` statement with `return` and wraps the source in a
 * function body. This supports the fixtures; it is NOT a general-purpose
 * ESM-to-CJS transform.
 */

export interface FakeWorkerLoaderOptions {
  /** Observer called with the versionId on each `get()` call. */
  onGetCall?: (versionId: string) => void;
  /** Observer called with the synthesized env on each factory invocation. */
  onFactoryCall?: (env: Record<string, unknown>) => void;
  /**
   * Hook that short-circuits bundle fetches before the bundle's default
   * export runs. Return a Response to skip; return null to let the real
   * bundle run. Useful for injecting hard errors / slowdowns.
   */
  beforeFetch?: (request: Request) => Response | null | Promise<Response | null>;
}

export interface FakeWorkerLoader extends WorkerLoader {
  /** Total number of `loader.get(...)` calls observed. */
  readonly callCount: number;
}

interface CompiledBundle {
  default: { fetch: (req: Request, env: unknown) => Promise<Response> };
}

function compileBundleSource(source: string): CompiledBundle {
  // Rewrite `export default <expr>;` → `return <expr>;` and wrap in a
  // function body so the bundle's top-level statements (const/function
  // declarations) remain valid inside `new Function`.
  const rewritten = source.replace(/export\s+default\s+/, "return ");
  // biome-ignore lint/security/noGlobalEval: test-only fake-loader
  const factory = new Function(rewritten) as () => CompiledBundle["default"];
  const defaultExport = factory();
  return { default: defaultExport };
}

export function makeFakeWorkerLoader(options: FakeWorkerLoaderOptions = {}): FakeWorkerLoader {
  let callCount = 0;
  const loader = {
    get callCount() {
      return callCount;
    },
    get(versionId: string, factory: () => Promise<unknown>) {
      callCount += 1;
      options.onGetCall?.(versionId);

      // Kick off the factory eagerly so getEntrypoint() can stay sync
      // (mirroring the real WorkerLoader contract).
      const factoryPromise = (async () => {
        const init = (await factory()) as {
          modules: Record<string, string>;
          env: Record<string, unknown>;
          mainModule: string;
        };
        options.onFactoryCall?.(init.env);
        const source = init.modules[init.mainModule];
        const mod = compileBundleSource(source);
        return { mod, env: init.env };
      })();

      return {
        getEntrypoint() {
          return {
            async fetch(req: Request) {
              const override = await options.beforeFetch?.(req);
              if (override) return override;
              const { mod, env } = await factoryPromise;
              return mod.default.fetch(req, env);
            },
          };
        },
      };
    },
  };
  return loader as unknown as FakeWorkerLoader;
}
