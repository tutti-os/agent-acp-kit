import type { RuntimeProvider } from "../core/provider-plugin.js";
import { getRuntimeTarget, getRuntimeTargetKey } from "../core/registry.js";

export function createProviderRegistry<
  TContext,
  TEvent,
  TKind extends string = string,
  TProvider extends string = string,
>(
  providers: RuntimeProvider<TContext, TEvent, TKind, TProvider>[],
) {
  const providerMap = new Map(
    providers.map((provider) => [
      getRuntimeTargetKey(getRuntimeTarget(provider.runtime)),
      provider,
    ]),
  );

  return {
    getProviderCount() {
      return providerMap.size;
    },
    getProviders() {
      return providers.slice();
    },
    getProviderByTargetKey(targetKey: string) {
      return providerMap.get(targetKey);
    },
  };
}
