/**
 * Lazy handles to the official provider SDKs.
 *
 * Each SDK is large and most invocations never open a provider connection, so
 * the SDK modules load on first use instead of at process start. `load()` is
 * the only way to obtain a client constructor. `loaded()` is for classifying an
 * error thrown by an SDK: such an error can only exist after `load()` resolved,
 * so an `undefined` handle means the error is not the SDK's.
 */

export type SdkHandle<Module> = {
  readonly load: () => Promise<Module>;
  readonly loaded: () => Module | undefined;
};

function lazySdk<Module>(importer: () => Promise<Module>): SdkHandle<Module> {
  let module: Module | undefined;
  let pending: Promise<Module> | undefined;
  return {
    load: () => {
      pending ??= importer().then(
        (imported) => {
          module = imported;
          return imported;
        },
        (error: unknown) => {
          pending = undefined;
          throw error;
        },
      );
      return pending;
    },
    loaded: () => module,
  };
}

export const openAiSdk = lazySdk(() => import("openai"));
export const anthropicSdk = lazySdk(() => import("@anthropic-ai/sdk"));
export const googleGenAiSdk = lazySdk(() => import("@google/genai"));
