import { DefaultResourceLoader, type SettingsManager } from "@mariozechner/pi-coding-agent";

export async function createEmbeddedResourceLoader(params: {
  cwd: string;
  agentDir: string;
  settingsManager: SettingsManager;
  systemPromptOverride: (base: string | undefined) => string | undefined;
  additionalExtensionPaths: string[];
}): Promise<DefaultResourceLoader> {
  const resourceLoader = new DefaultResourceLoader({
    cwd: params.cwd,
    agentDir: params.agentDir,
    settingsManager: params.settingsManager,
    additionalExtensionPaths: params.additionalExtensionPaths,
    noSkills: true,
    agentsFilesOverride: () => ({ agentsFiles: [] }),
    systemPromptOverride: params.systemPromptOverride,
    appendSystemPromptOverride: () => [],
  });
  await resourceLoader.reload();
  return resourceLoader;
}
