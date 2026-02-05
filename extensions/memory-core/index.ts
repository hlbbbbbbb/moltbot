import type { ClawdbotPluginApi } from "clawdbot/plugin-sdk";
import { emptyPluginConfigSchema } from "clawdbot/plugin-sdk";

const memoryCorePlugin = {
  id: "memory-core",
  name: "Memory (Core)",
  description: "File-backed memory search tools and CLI",
  kind: "memory",
  configSchema: emptyPluginConfigSchema(),
  register(api: ClawdbotPluginApi) {
    // Register semantic memory tools (MEMORY.md + memory/*.md)
    api.registerTool(
      (ctx) => {
        const memorySearchTool = api.runtime.tools.createMemorySearchTool({
          config: ctx.config,
          agentSessionKey: ctx.sessionKey,
        });
        const memoryGetTool = api.runtime.tools.createMemoryGetTool({
          config: ctx.config,
          agentSessionKey: ctx.sessionKey,
        });
        if (!memorySearchTool || !memoryGetTool) return null;
        return [memorySearchTool, memoryGetTool];
      },
      { names: ["memory_search", "memory_get"] },
    );

    // Register episodic memory tools (episodes/ + memory-index.json)
    api.registerTool(
      (ctx) => {
        const episodeSearchTool = api.runtime.tools.createEpisodeSearchTool({
          config: ctx.config,
          agentSessionKey: ctx.sessionKey,
        });
        const memoryOverviewTool = api.runtime.tools.createMemoryOverviewTool({
          config: ctx.config,
          agentSessionKey: ctx.sessionKey,
        });
        if (!episodeSearchTool || !memoryOverviewTool) return null;
        return [episodeSearchTool, memoryOverviewTool];
      },
      { names: ["episode_search", "memory_overview"] },
    );

    api.registerCli(
      ({ program }) => {
        api.runtime.tools.registerMemoryCli(program);
      },
      { commands: ["memory"] },
    );
  },
};

export default memoryCorePlugin;
