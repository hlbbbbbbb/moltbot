import type { ReactiveController, ReactiveControllerHost } from "lit";
import type { ApiProvider } from "../views/api-config";
import { DEFAULT_PROVIDERS } from "../views/api-config";

export type ApiConfigState = {
  providers: ApiProvider[];
  currentValues: Record<string, string>;
  loading: boolean;
  saving: boolean;
  connected: boolean;
  error: string | null;
};

export class ApiConfigController implements ReactiveController {
  host: ReactiveControllerHost;
  private gateway: any;
  private state: ApiConfigState;
  private pendingChanges: Record<string, string> = {};

  constructor(host: ReactiveControllerHost, gateway: any) {
    this.host = host;
    this.gateway = gateway;
    this.state = {
      providers: DEFAULT_PROVIDERS,
      currentValues: {},
      loading: false,
      saving: false,
      connected: false,
      error: null,
    };
    host.addController(this);
  }

  hostConnected() {
    this.loadCurrentConfig();
  }

  hostDisconnected() {}

  getState(): ApiConfigState {
    return { ...this.state };
  }

  private updateState(updates: Partial<ApiConfigState>) {
    this.state = { ...this.state, ...updates };
    this.host.requestUpdate();
  }

  async loadCurrentConfig() {
    this.updateState({ loading: true, error: null });

    try {
      const connected = this.gateway.connected();
      if (!connected) {
        this.updateState({ loading: false, connected: false });
        return;
      }

      // 调用 Gateway API 获取当前配置
      const response = await this.gateway.call("config.get", {});
      
      if (response.error) {
        throw new Error(response.error.message || "Failed to load config");
      }

      const config = response.result?.value || {};
      const currentValues: Record<string, string> = {};

      // 提取各个 provider 的 API Key
      for (const provider of this.state.providers) {
        // 先尝试从 env 中获取
        const envValue = config.env?.[provider.envKey];
        if (envValue) {
          currentValues[provider.id] = envValue;
          continue;
        }

        // 再尝试从 models.providers 中获取
        const pathParts = provider.configPath.split(".");
        let value = config;
        for (const part of pathParts) {
          value = value?.[part];
        }
        if (value && typeof value === "string") {
          currentValues[provider.id] = value;
        }
      }

      this.updateState({
        loading: false,
        connected: true,
        currentValues,
      });
    } catch (error) {
      console.error("Failed to load API config:", error);
      this.updateState({
        loading: false,
        error: error instanceof Error ? error.message : "Unknown error",
      });
    }
  }

  handleApiKeyChange(providerId: string, value: string) {
    this.pendingChanges[providerId] = value;
    
    // 更新本地显示状态
    const currentValues = { ...this.state.currentValues };
    if (value) {
      currentValues[providerId] = value;
    } else {
      delete currentValues[providerId];
    }
    
    this.updateState({ currentValues });
  }

  async saveConfig() {
    if (Object.keys(this.pendingChanges).length === 0) {
      return;
    }

    this.updateState({ saving: true, error: null });

    try {
      // 获取当前配置
      const configResponse = await this.gateway.call("config.get", {});
      if (configResponse.error) {
        throw new Error("Failed to get current config");
      }

      const currentConfig = configResponse.result?.value || {};
      const hash = configResponse.result?.hash;

      // 构建更新对象
      const updates: any = { env: { ...currentConfig.env } };

      for (const [providerId, value] of Object.entries(this.pendingChanges)) {
        const provider = this.state.providers.find((p) => p.id === providerId);
        if (!provider) continue;

        if (value) {
          // 设置到 env 中（推荐方式）
          updates.env[provider.envKey] = value;
        } else {
          // 删除 API Key
          if (updates.env[provider.envKey]) {
            updates.env[provider.envKey] = null; // JSON merge patch 语义
          }
        }
      }

      // 使用 config.patch 更新配置
      const patchResponse = await this.gateway.call("config.patch", {
        raw: JSON.stringify(updates, null, 2),
        baseHash: hash,
        note: "Updated API keys from UI",
        restartDelayMs: 2000,
      });

      if (patchResponse.error) {
        throw new Error(patchResponse.error.message || "Failed to save config");
      }

      // 清空待保存的更改
      this.pendingChanges = {};

      this.updateState({ saving: false });

      // 显示成功消息
      this.showNotification("✓ API 配置已保存，Gateway 即将重启", "success");

      // 等待 Gateway 重启后刷新配置
      setTimeout(() => {
        this.loadCurrentConfig();
      }, 3000);
    } catch (error) {
      console.error("Failed to save API config:", error);
      this.updateState({
        saving: false,
        error: error instanceof Error ? error.message : "Unknown error",
      });
      this.showNotification("✗ 保存失败: " + (error instanceof Error ? error.message : "Unknown error"), "error");
    }
  }

  async refreshModels(providerId: string) {
    this.showNotification(`🔄 正在刷新 ${providerId} 的模型列表...`, "info");

    try {
      // 调用 models list 或 scan 命令
      // 这里需要根据实际的 Gateway API 来实现
      const response = await this.gateway.call("models.list", {
        provider: providerId,
      });

      if (response.error) {
        throw new Error(response.error.message || "Failed to refresh models");
      }

      const models = response.result?.models || [];
      this.showNotification(`✓ 成功刷新 ${models.length} 个模型`, "success");
    } catch (error) {
      console.error("Failed to refresh models:", error);
      this.showNotification("✗ 刷新模型失败", "error");
    }
  }

  async testConnection(providerId: string) {
    const provider = this.state.providers.find((p) => p.id === providerId);
    if (!provider) return;

    this.showNotification(`🔍 正在测试 ${provider.name} 连接...`, "info");

    try {
      // 简单的测试：尝试列出该 provider 的模型
      const response = await this.gateway.call("models.list", {
        provider: providerId,
      });

      if (response.error) {
        throw new Error(response.error.message || "Connection test failed");
      }

      this.showNotification(`✓ ${provider.name} 连接成功！`, "success");
    } catch (error) {
      console.error("Connection test failed:", error);
      this.showNotification(
        `✗ ${provider.name} 连接失败: ${error instanceof Error ? error.message : "Unknown error"}`,
        "error"
      );
    }
  }

  private showNotification(message: string, type: "success" | "error" | "info") {
    // 创建一个简单的通知元素
    const notification = document.createElement("div");
    notification.className = `api-config-notification notification-${type}`;
    notification.textContent = message;
    notification.style.cssText = `
      position: fixed;
      top: 2rem;
      right: 2rem;
      padding: 1rem 1.5rem;
      border-radius: 0.5rem;
      background: ${
        type === "success"
          ? "rgba(34, 197, 94, 0.9)"
          : type === "error"
          ? "rgba(239, 68, 68, 0.9)"
          : "rgba(59, 130, 246, 0.9)"
      };
      color: white;
      font-weight: 500;
      box-shadow: 0 10px 15px -3px rgba(0, 0, 0, 0.1);
      z-index: 10000;
      animation: slideIn 0.3s ease-out;
    `;

    document.body.appendChild(notification);

    // 3秒后自动移除
    setTimeout(() => {
      notification.style.animation = "slideOut 0.3s ease-in";
      setTimeout(() => {
        notification.remove();
      }, 300);
    }, 3000);
  }
}
