import path from "node:path";

import { AuthStorage, ModelRegistry } from "@mariozechner/pi-coding-agent";

function resolvePiSdkPaths(agentDir?: string): {
  authPath?: string;
  modelsPath?: string;
} {
  return agentDir
    ? {
        authPath: path.join(agentDir, "auth.json"),
        modelsPath: path.join(agentDir, "models.json"),
      }
    : {};
}

export function discoverAuthStorage(agentDir?: string): AuthStorage {
  const { authPath } = resolvePiSdkPaths(agentDir);
  return AuthStorage.create(authPath);
}

export function discoverModels(authStorage: AuthStorage, agentDir?: string): ModelRegistry {
  const { modelsPath } = resolvePiSdkPaths(agentDir);
  return new ModelRegistry(authStorage, modelsPath);
}

export type DiscoveredAuthStorage = ReturnType<typeof discoverAuthStorage>;
export type DiscoveredModelRegistry = ReturnType<typeof discoverModels>;
