import type { ChannelId, ChannelOutboundAdapter } from "../types.js";
import type { PluginRegistry } from "../../../plugins/registry.js";
import { getActivePluginRegistry } from "../../../plugins/runtime.js";
import { wecomOutbound } from "./wecom.js";

// Channel docking: outbound sends should stay cheap to import.
//
// The full channel plugins (src/channels/plugins/*.ts) pull in status,
// onboarding, gateway monitors, etc. Outbound delivery only needs chunking +
// send primitives, so we keep a dedicated, lightweight loader here.
const cache = new Map<ChannelId, ChannelOutboundAdapter>();
let lastRegistry: PluginRegistry | null = null;

function ensureCacheForRegistry(registry: PluginRegistry | null) {
  if (registry === lastRegistry) return;
  cache.clear();
  lastRegistry = registry;
}

export async function loadChannelOutboundAdapter(
  id: ChannelId,
): Promise<ChannelOutboundAdapter | undefined> {
  // WeCom outbound - disabled, AI doesn't use it correctly yet
  // if (id === "wecom" || id === "wecom-kf") {
  //   return wecomOutbound;
  // }

  const registry = getActivePluginRegistry();
  ensureCacheForRegistry(registry);
  const cached = cache.get(id);
  if (cached) return cached;
  const pluginEntry = registry?.channels.find((entry) => entry.plugin.id === id);
  const outbound = pluginEntry?.plugin.outbound;
  if (outbound) {
    cache.set(id, outbound);
    return outbound;
  }
  return undefined;
}
