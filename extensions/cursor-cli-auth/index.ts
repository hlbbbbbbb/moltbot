import { emptyPluginConfigSchema } from "clawdbot/plugin-sdk";

import { DEFAULT_MODELS, loginCursorCliOAuth } from "./oauth.js";

const PROVIDER_ID = "cursor-cli";
const PROVIDER_LABEL = "Cursor CLI";
const DEFAULT_MODEL = "cursor-cli/claude-4.5-sonnet";
const DEFAULT_CONTEXT_WINDOW = 200_000;
const DEFAULT_MAX_TOKENS = 8192;

// Cursor API configuration
const CURSOR_API_BASE_URL = "https://api2.cursor.sh/v1";

function buildModelDefinition(modelId: string) {
  // Infer reasoning mode based on model ID
  const isReasoning = modelId.includes("opus");
  
  let contextWindow = DEFAULT_CONTEXT_WINDOW;
  
  // Adjust context window based on model
  if (modelId.includes("gemini")) {
    contextWindow = 1_000_000;
  } else if (modelId.includes("gpt-5")) {
    contextWindow = 272_000;
  } else if (modelId.includes("grok")) {
    contextWindow = 256_000;
  }

  return {
    id: modelId,
    name: modelId,
    api: "openai-completions",
    reasoning: isReasoning,
    input: ["text", "image"],
  };
}

const cursorCliPlugin = {
  id: "cursor-cli-auth",
  name: "Cursor CLI Auth",
  description: "OAuth flow for Cursor CLI (access Cursor's AI models)",
  configSchema: emptyPluginConfigSchema(),
  register(api) {
    api.registerProvider({
      id: PROVIDER_ID,
      label: PROVIDER_LABEL,
      docsPath: "/providers/models",
      aliases: ["cursor"],
      envVars: ["CURSOR_ACCESS_TOKEN", "CURSOR_REFRESH_TOKEN"],
      auth: [
        {
          id: "oauth",
          label: "Cursor OAuth",
          hint: "Sign in with your Cursor account",
          kind: "oauth",
          run: async (ctx) => {
            const spin = ctx.prompter.progress("Starting Cursor CLI OAuth...");
            try {
              const result = await loginCursorCliOAuth({
                isRemote: ctx.isRemote,
                openUrl: ctx.openUrl,
                log: (msg) => ctx.runtime.log(msg),
                note: ctx.prompter.note,
                prompt: async (message) => String(await ctx.prompter.text({ message })),
                progress: spin,
              });

              spin.stop("Cursor CLI OAuth complete");

              const profileId = `cursor-cli:${result.email ?? result.userId ?? "default"}`;
              const models = DEFAULT_MODELS.map((m) => buildModelDefinition(m));
              const modelConfigs = Object.fromEntries(
                models.map((m) => [`cursor-cli/${m.id}`, {}]),
              );

              return {
                profiles: [
                  {
                    profileId,
                    credential: {
                      type: "oauth",
                      provider: PROVIDER_ID,
                      access: result.access,
                      refresh: result.refresh,
                      expires: result.expires,
                      email: result.email,
                      userId: result.userId,
                    },
                  },
                ],
                configPatch: {
                  models: {
                    providers: {
                      [PROVIDER_ID]: {
                        baseUrl: CURSOR_API_BASE_URL,
                        api: "openai-completions",
                        models,
                      },
                    },
                  },
                  agents: {
                    defaults: {
                      models: modelConfigs,
                    },
                  },
                },
                defaultModel: DEFAULT_MODEL,
                notes: [
                  "Cursor CLI uses your Cursor subscription for model access.",
                  "Available models depend on your Cursor plan (Pro, Business, etc.).",
                  "Token refresh is automatic when tokens expire.",
                ],
              };
            } catch (err) {
              spin.stop("Cursor CLI OAuth failed");
              await ctx.prompter.note(
                "Ensure you have an active Cursor subscription and try again.",
                "OAuth help",
              );
              throw err;
            }
          },
        },
        {
          id: "token",
          label: "Access Token",
          hint: "Use pre-configured CURSOR_ACCESS_TOKEN",
          kind: "env",
          run: async (ctx) => {
            const envToken = process.env.CURSOR_ACCESS_TOKEN?.trim();
            if (!envToken) {
              throw new Error(
                "CURSOR_ACCESS_TOKEN environment variable not set. " +
                  "Set it or use OAuth login instead.",
              );
            }

            const profileId = "cursor-cli:env";
            const models = DEFAULT_MODELS.map((m) => buildModelDefinition(m));
            const modelConfigs = Object.fromEntries(
              models.map((m) => [`cursor-cli/${m.id}`, {}]),
            );

            return {
              profiles: [
                {
                  profileId,
                  credential: {
                    type: "token",
                    provider: PROVIDER_ID,
                    token: envToken,
                  },
                },
              ],
              configPatch: {
                models: {
                  providers: {
                    [PROVIDER_ID]: {
                      baseUrl: CURSOR_API_BASE_URL,
                      api: "openai-completions",
                      models,
                    },
                  },
                },
                agents: {
                  defaults: {
                    models: modelConfigs,
                  },
                },
              },
              defaultModel: DEFAULT_MODEL,
              notes: [
                "Using CURSOR_ACCESS_TOKEN from environment.",
                "Ensure the token is valid and not expired.",
              ],
            };
          },
        },
      ],
    });
  },
};

export default cursorCliPlugin;
