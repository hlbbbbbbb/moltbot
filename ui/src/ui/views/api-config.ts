import { html, nothing } from "lit";
import type { TemplateResult } from "lit";

export type ApiProvider = {
  id: string;
  name: string;
  envKey: string;
  configPath: string;
  description: string;
  models?: string[];
};

export type ApiConfigProps = {
  providers: ApiProvider[];
  currentValues: Record<string, string>;
  loading: boolean;
  saving: boolean;
  connected: boolean;
  onApiKeyChange: (providerId: string, value: string) => void;
  onSave: () => void;
  onRefreshModels: (providerId: string) => void;
  onTestConnection: (providerId: string) => void;
};

// 预定义的 Provider 列表
export const DEFAULT_PROVIDERS: ApiProvider[] = [
  {
    id: "minimax",
    name: "MiniMax",
    envKey: "MINIMAX_API_KEY",
    configPath: "models.providers.minimax.apiKey",
    description: "MiniMax AI models - 更好的写作和对话体验",
    models: ["MiniMax-Text-01", "MiniMax-M2.1"],
  },
  {
    id: "openai",
    name: "OpenAI",
    envKey: "OPENAI_API_KEY",
    configPath: "models.providers.openai.apiKey",
    description: "OpenAI GPT models - GPT-4, GPT-5.2 等",
    models: ["gpt-4o", "gpt-5.2", "gpt-4o-mini"],
  },
  {
    id: "anthropic",
    name: "Anthropic",
    envKey: "ANTHROPIC_API_KEY",
    configPath: "models.providers.anthropic.apiKey",
    description: "Claude models - Claude Opus, Claude Sonnet 等",
    models: ["claude-opus-4-5", "claude-sonnet-4-5"],
  },
  {
    id: "openrouter",
    name: "OpenRouter",
    envKey: "OPENROUTER_API_KEY",
    configPath: "models.providers.openrouter.apiKey",
    description: "OpenRouter - 访问多个 AI 模型",
  },
  {
    id: "groq",
    name: "Groq",
    envKey: "GROQ_API_KEY",
    configPath: "models.providers.groq.apiKey",
    description: "Groq - 超快速推理",
  },
  {
    id: "gemini",
    name: "Google Gemini",
    envKey: "GEMINI_API_KEY",
    configPath: "models.providers.google.apiKey",
    description: "Google Gemini models",
  },
  {
    id: "zai",
    name: "Z.AI (智谱)",
    envKey: "ZAI_API_KEY",
    configPath: "models.providers.zai.apiKey",
    description: "智谱 AI - GLM 系列模型",
    models: ["glm-4.7", "glm-4-plus"],
  },
];

export function renderApiConfig(props: ApiConfigProps): TemplateResult {
  const {
    providers = DEFAULT_PROVIDERS,
    currentValues,
    loading,
    saving,
    connected,
    onApiKeyChange,
    onSave,
    onRefreshModels,
    onTestConnection,
  } = props;

  if (!connected) {
    return html`
      <div class="api-config-disconnected">
        <div class="glass-panel">
          <div class="icon-large">🔌</div>
          <h2>未连接到 Gateway</h2>
          <p>请先连接 Gateway 才能配置 API</p>
        </div>
      </div>
    `;
  }

  return html`
    <div class="api-config-container">
      <!-- Header -->
      <div class="api-config-header">
        <div class="header-content">
          <h1>🔑 API 配置</h1>
          <p class="subtitle">管理你的 AI Provider API Keys，配置后自动拉取可用模型</p>
        </div>
        <div class="header-actions">
          <button
            class="btn btn-primary"
            ?disabled=${saving || loading}
            @click=${onSave}
          >
            ${saving ? "保存中..." : "💾 保存配置"}
          </button>
        </div>
      </div>

      <!-- Provider Cards -->
      <div class="api-providers-grid">
        ${providers.map((provider) => {
          const currentValue = currentValues[provider.id] || "";
          const hasValue = currentValue.length > 0;
          const isMasked = hasValue && !currentValue.startsWith("sk-");

          return html`
            <div class="api-provider-card glass-panel">
              <!-- Provider Header -->
              <div class="provider-header">
                <div class="provider-info">
                  <h3>${provider.name}</h3>
                  <p class="provider-description">${provider.description}</p>
                </div>
                <div class="provider-status">
                  ${hasValue
                    ? html`<span class="status-badge status-active">✓ 已配置</span>`
                    : html`<span class="status-badge status-inactive">未配置</span>`}
                </div>
              </div>

              <!-- API Key Input -->
              <div class="api-key-input-group">
                <label for="api-${provider.id}">
                  API Key
                  <span class="env-hint">(${provider.envKey})</span>
                </label>
                <div class="input-with-actions">
                  <input
                    id="api-${provider.id}"
                    type="password"
                    class="api-key-input"
                    placeholder="${hasValue && isMasked ? "••••••••" : "输入 API Key"}"
                    .value=${hasValue && !isMasked ? currentValue : ""}
                    @input=${(e: Event) => {
                      const input = e.target as HTMLInputElement;
                      onApiKeyChange(provider.id, input.value);
                    }}
                    ?disabled=${loading || saving}
                  />
                  ${hasValue
                    ? html`
                        <button
                          class="btn-icon"
                          title="清除"
                          @click=${() => onApiKeyChange(provider.id, "")}
                        >
                          ✕
                        </button>
                      `
                    : nothing}
                </div>
                <div class="input-hint">
                  配置路径: <code>${provider.configPath}</code>
                </div>
              </div>

              <!-- Models Preview -->
              ${provider.models && provider.models.length > 0
                ? html`
                    <div class="provider-models">
                      <div class="models-label">支持的模型:</div>
                      <div class="models-list">
                        ${provider.models.map(
                          (model) => html`
                            <span class="model-tag">${model}</span>
                          `
                        )}
                      </div>
                    </div>
                  `
                : nothing}

              <!-- Action Buttons -->
              <div class="provider-actions">
                <button
                  class="btn btn-secondary btn-sm"
                  ?disabled=${!hasValue || loading}
                  @click=${() => onTestConnection(provider.id)}
                >
                  🔍 测试连接
                </button>
                <button
                  class="btn btn-secondary btn-sm"
                  ?disabled=${!hasValue || loading}
                  @click=${() => onRefreshModels(provider.id)}
                >
                  🔄 刷新模型
                </button>
              </div>
            </div>
          `;
        })}
      </div>

      <!-- Quick Tips -->
      <div class="api-config-tips glass-panel">
        <h3>💡 快速提示</h3>
        <ul>
          <li><strong>推荐:</strong> MiniMax 适合中文对话和写作</li>
          <li><strong>环境变量:</strong> 也可以在 <code>~/.clawdbot/.env</code> 中配置</li>
          <li><strong>优先级:</strong> 配置文件 > UI 配置 > 环境变量</li>
          <li><strong>安全:</strong> API Key 会加密存储在本地配置中</li>
          <li><strong>自动刷新:</strong> 保存后会自动拉取该 Provider 的可用模型列表</li>
        </ul>
      </div>
    </div>

    <style>
      .api-config-container {
        padding: 2rem;
        max-width: 1400px;
        margin: 0 auto;
      }

      .api-config-header {
        display: flex;
        justify-content: space-between;
        align-items: flex-start;
        margin-bottom: 2rem;
        gap: 2rem;
      }

      .header-content h1 {
        margin: 0 0 0.5rem 0;
        font-size: 2rem;
        font-weight: 700;
      }

      .subtitle {
        color: var(--text-secondary);
        margin: 0;
      }

      .header-actions {
        flex-shrink: 0;
      }

      .api-providers-grid {
        display: grid;
        grid-template-columns: repeat(auto-fill, minmax(400px, 1fr));
        gap: 1.5rem;
        margin-bottom: 2rem;
      }

      .api-provider-card {
        padding: 1.5rem;
        display: flex;
        flex-direction: column;
        gap: 1rem;
      }

      .provider-header {
        display: flex;
        justify-content: space-between;
        align-items: flex-start;
        gap: 1rem;
      }

      .provider-info h3 {
        margin: 0 0 0.25rem 0;
        font-size: 1.25rem;
        font-weight: 600;
      }

      .provider-description {
        color: var(--text-secondary);
        margin: 0;
        font-size: 0.875rem;
      }

      .status-badge {
        padding: 0.25rem 0.75rem;
        border-radius: 1rem;
        font-size: 0.75rem;
        font-weight: 600;
        white-space: nowrap;
      }

      .status-active {
        background: rgba(34, 197, 94, 0.2);
        color: rgb(34, 197, 94);
      }

      .status-inactive {
        background: rgba(156, 163, 175, 0.2);
        color: rgb(156, 163, 175);
      }

      .api-key-input-group {
        display: flex;
        flex-direction: column;
        gap: 0.5rem;
      }

      .api-key-input-group label {
        font-weight: 500;
        display: flex;
        align-items: center;
        gap: 0.5rem;
      }

      .env-hint {
        color: var(--text-secondary);
        font-size: 0.875rem;
        font-weight: 400;
      }

      .input-with-actions {
        display: flex;
        gap: 0.5rem;
      }

      .api-key-input {
        flex: 1;
        padding: 0.75rem;
        border: 1px solid var(--border-color);
        border-radius: 0.5rem;
        background: var(--bg-secondary);
        color: var(--text-primary);
        font-family: 'Courier New', monospace;
        font-size: 0.875rem;
      }

      .api-key-input:focus {
        outline: none;
        border-color: var(--primary-color);
        box-shadow: 0 0 0 3px rgba(59, 130, 246, 0.1);
      }

      .btn-icon {
        padding: 0.75rem;
        border: 1px solid var(--border-color);
        border-radius: 0.5rem;
        background: var(--bg-secondary);
        color: var(--text-secondary);
        cursor: pointer;
        transition: all 0.2s;
      }

      .btn-icon:hover {
        background: var(--bg-hover);
        color: var(--text-primary);
      }

      .input-hint {
        font-size: 0.75rem;
        color: var(--text-secondary);
      }

      .input-hint code {
        background: var(--bg-secondary);
        padding: 0.125rem 0.375rem;
        border-radius: 0.25rem;
        font-family: 'Courier New', monospace;
      }

      .provider-models {
        padding-top: 0.5rem;
        border-top: 1px solid var(--border-color);
      }

      .models-label {
        font-size: 0.875rem;
        font-weight: 500;
        margin-bottom: 0.5rem;
      }

      .models-list {
        display: flex;
        flex-wrap: wrap;
        gap: 0.5rem;
      }

      .model-tag {
        padding: 0.25rem 0.625rem;
        background: var(--bg-secondary);
        border: 1px solid var(--border-color);
        border-radius: 0.375rem;
        font-size: 0.75rem;
        color: var(--text-secondary);
      }

      .provider-actions {
        display: flex;
        gap: 0.5rem;
      }

      .btn {
        padding: 0.75rem 1.5rem;
        border: none;
        border-radius: 0.5rem;
        font-weight: 500;
        cursor: pointer;
        transition: all 0.2s;
      }

      .btn-primary {
        background: var(--primary-color);
        color: white;
      }

      .btn-primary:hover:not(:disabled) {
        background: var(--primary-hover);
      }

      .btn-secondary {
        background: var(--bg-secondary);
        color: var(--text-primary);
        border: 1px solid var(--border-color);
      }

      .btn-secondary:hover:not(:disabled) {
        background: var(--bg-hover);
      }

      .btn-sm {
        padding: 0.5rem 1rem;
        font-size: 0.875rem;
        flex: 1;
      }

      .btn:disabled {
        opacity: 0.5;
        cursor: not-allowed;
      }

      .api-config-tips {
        padding: 1.5rem;
      }

      .api-config-tips h3 {
        margin: 0 0 1rem 0;
        font-size: 1.125rem;
      }

      .api-config-tips ul {
        margin: 0;
        padding-left: 1.5rem;
      }

      .api-config-tips li {
        margin-bottom: 0.5rem;
        color: var(--text-secondary);
      }

      .api-config-tips code {
        background: var(--bg-secondary);
        padding: 0.125rem 0.375rem;
        border-radius: 0.25rem;
        font-family: 'Courier New', monospace;
        font-size: 0.875rem;
      }

      .api-config-disconnected {
        display: flex;
        align-items: center;
        justify-content: center;
        min-height: 400px;
      }

      .api-config-disconnected .glass-panel {
        text-align: center;
        padding: 3rem;
      }

      .icon-large {
        font-size: 4rem;
        margin-bottom: 1rem;
      }

      @media (max-width: 768px) {
        .api-config-container {
          padding: 1rem;
        }

        .api-config-header {
          flex-direction: column;
          gap: 1rem;
        }

        .api-providers-grid {
          grid-template-columns: 1fr;
        }

        .provider-actions {
          flex-direction: column;
        }
      }
    </style>
  `;
}
