import {
  DEFAULT_ACCOUNT_ID,
  type ChannelPlugin,
  type ClawdbotConfig,
} from "clawdbot/plugin-sdk";

import { getWeComRuntime } from "./runtime.js";

// 直接导入 wecom 模块（使用相对路径到 dist）
async function loadWeComModules() {
  const monitor = await import("../../../dist/wecom/monitor.js");
  const probe = await import("../../../dist/wecom/probe.js");
  const send = await import("../../../dist/wecom/send.js");
  return { monitor, probe, send };
}

let wecomModules: Awaited<ReturnType<typeof loadWeComModules>> | null = null;

async function getWeComModules() {
  if (!wecomModules) {
    wecomModules = await loadWeComModules();
  }
  return wecomModules;
}

// 企业微信账号配置类型
interface ResolvedWeComAccount {
  accountId: string;
  name?: string;
  enabled: boolean;
  corpId: string;
  agentId: number;
  secret: string;
  token: string;
  encodingAESKey: string;
  callbackPort?: number;
  allowFrom?: string[];
  config: {
    corpId?: string;
    agentId?: number;
    secret?: string;
    token?: string;
    encodingAESKey?: string;
    callbackPort?: number;
    allowFrom?: string[];
    historyLimit?: number;
  };
}

// 从配置解析账号
function resolveWeComAccount(params: {
  cfg: ClawdbotConfig;
  accountId?: string;
}): ResolvedWeComAccount {
  const { cfg, accountId = DEFAULT_ACCOUNT_ID } = params;
  const wecomCfg = cfg.channels?.wecom as Record<string, unknown> | undefined;

  if (!wecomCfg) {
    return {
      accountId,
      enabled: false,
      corpId: "",
      agentId: 0,
      secret: "",
      token: "",
      encodingAESKey: "",
      config: {},
    };
  }

  // 尝试从 accounts 获取
  const accounts = wecomCfg.accounts as Record<string, unknown> | undefined;
  const accountCfg =
    accountId !== DEFAULT_ACCOUNT_ID && accounts?.[accountId]
      ? (accounts[accountId] as Record<string, unknown>)
      : wecomCfg;

  const corpId = (accountCfg.corpId as string) || "";
  const agentId = (accountCfg.agentId as number) || 0;
  const secret = (accountCfg.secret as string) || "";
  const token = (accountCfg.token as string) || "";
  const encodingAESKey = (accountCfg.encodingAESKey as string) || "";
  const callbackPort = accountCfg.callbackPort as number | undefined;
  const allowFrom = accountCfg.allowFrom as string[] | undefined;
  const enabled = accountCfg.enabled !== false;
  const name = accountCfg.name as string | undefined;

  return {
    accountId,
    name,
    enabled,
    corpId,
    agentId,
    secret,
    token,
    encodingAESKey,
    callbackPort,
    allowFrom,
    config: {
      corpId,
      agentId,
      secret,
      token,
      encodingAESKey,
      callbackPort,
      allowFrom,
      historyLimit: accountCfg.historyLimit as number | undefined,
    },
  };
}

// 列出所有账号 ID
function listWeComAccountIds(cfg: ClawdbotConfig): string[] {
  const wecomCfg = cfg.channels?.wecom as Record<string, unknown> | undefined;
  if (!wecomCfg) return [];

  const ids: string[] = [];

  // 默认账号
  if (wecomCfg.corpId && wecomCfg.secret) {
    ids.push(DEFAULT_ACCOUNT_ID);
  }

  // 多账号
  const accounts = wecomCfg.accounts as Record<string, unknown> | undefined;
  if (accounts) {
    for (const [id, account] of Object.entries(accounts)) {
      if (account && typeof account === "object" && (account as { corpId?: string }).corpId) {
        if (!ids.includes(id)) {
          ids.push(id);
        }
      }
    }
  }

  return ids;
}

export const wecomPlugin: ChannelPlugin<ResolvedWeComAccount> = {
  id: "wecom",
  meta: {
    label: "WeCom",
    emoji: "💼",
    order: 50,
  },
  capabilities: {
    chatTypes: ["direct"],
    reactions: false,
    threads: false,
    media: false,
    nativeCommands: false,
    blockStreaming: false,
  },
  reload: { configPrefixes: ["channels.wecom"] },
  config: {
    listAccountIds: (cfg) => listWeComAccountIds(cfg),
    resolveAccount: (cfg, accountId) => resolveWeComAccount({ cfg, accountId }),
    defaultAccountId: () => DEFAULT_ACCOUNT_ID,
    isConfigured: (account) => Boolean(account.corpId?.trim() && account.secret?.trim()),
    describeAccount: (account) => ({
      accountId: account.accountId,
      name: account.name,
      enabled: account.enabled,
      configured: Boolean(account.corpId?.trim() && account.secret?.trim()),
    }),
    resolveAllowFrom: ({ cfg, accountId }) => {
      const account = resolveWeComAccount({ cfg, accountId });
      return (account.config.allowFrom ?? []).map(String);
    },
    formatAllowFrom: ({ allowFrom }) =>
      allowFrom
        .map((entry) => String(entry).trim())
        .filter(Boolean),
  },
  outbound: {
    deliveryMode: "direct",
    chunker: (text, limit) => getWeComRuntime().channel.text.chunkText(text, limit),
    chunkerMode: "text",
    textChunkLimit: 2000,
    sendText: async ({ to, text, accountId, deps }) => {
      const cfg = deps?.cfg;
      const account = cfg ? resolveWeComAccount({ cfg, accountId }) : null;
      
      if (!account || !account.corpId || !account.secret) {
        throw new Error("WeCom account not configured");
      }

      const modules = await getWeComModules();
      const result = await modules.send.sendWeComMessage({
        credentials: {
          corpId: account.corpId,
          secret: account.secret,
        },
        agentId: account.agentId,
        toUser: to,
        content: text,
      });
      
      return { channel: "wecom", ...result };
    },
  },
  status: {
    defaultRuntime: {
      accountId: DEFAULT_ACCOUNT_ID,
      running: false,
      lastStartAt: null,
      lastStopAt: null,
      lastError: null,
    },
    probeAccount: async ({ account }) => {
      const modules = await getWeComModules();
      return modules.probe.probeWeCom({
        corpId: account.corpId,
        secret: account.secret,
      });
    },
    buildAccountSnapshot: ({ account, runtime }) => ({
      accountId: account.accountId,
      name: account.name,
      enabled: account.enabled,
      configured: Boolean(account.corpId?.trim() && account.secret?.trim()),
      running: runtime?.running ?? false,
      lastStartAt: runtime?.lastStartAt ?? null,
      lastStopAt: runtime?.lastStopAt ?? null,
      lastError: runtime?.lastError ?? null,
    }),
  },
  gateway: {
    startAccount: async (ctx) => {
      const account = ctx.account;
      ctx.log?.info?.(`[${account.accountId}] starting WeCom provider (corpId: ${account.corpId})`);

      const modules = await getWeComModules();
      return modules.monitor.monitorWeComChannel({
        accountId: account.accountId,
        config: ctx.cfg,
        runtime: ctx.runtime,
        abortSignal: ctx.abortSignal,
      });
    },
  },
};
