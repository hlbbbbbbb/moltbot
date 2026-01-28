import type { PluginRuntimeEnv } from "clawdbot/plugin-sdk";

let runtime: PluginRuntimeEnv | null = null;

export function setWeComRuntime(r: PluginRuntimeEnv) {
  runtime = r;
}

export function getWeComRuntime(): PluginRuntimeEnv {
  if (!runtime) {
    throw new Error("WeCom runtime not initialized");
  }
  return runtime;
}
