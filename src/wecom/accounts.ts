/**
 * 企业微信账号配置
 */

import type { ClawdbotConfig } from "../config/config.js";

export interface WeComAccount {
  accountId: string;
  corpId: string;
  agentId: number;
  secret: string;
  token: string;
  encodingAESKey: string;
  callbackPort?: number;
  allowFrom?: string[];
}

// 企业微信配置类型
interface WeComConfigEntry {
  enabled?: boolean;
  corpId?: string;
  agentId?: number;
  secret?: string;
  token?: string;
  encodingAESKey?: string;
  callbackPort?: number;
  allowFrom?: string[];
  accounts?: Record<string, WeComConfigEntry>;
}

/**
 * 从配置中解析企业微信账号
 */
export function resolveWeComAccount(
  cfg: ClawdbotConfig,
  accountId: string = "default",
): WeComAccount | null {
  const wecomCfg = cfg.channels?.wecom as WeComConfigEntry | undefined;

  if (!wecomCfg) {
    return null;
  }

  // 支持单账号和多账号配置
  const accounts = wecomCfg.accounts || {};
  const accountCfg = accounts[accountId] || (accountId === "default" ? wecomCfg : null);

  if (!accountCfg?.corpId || !accountCfg?.secret) {
    return null;
  }

  return {
    accountId,
    corpId: accountCfg.corpId,
    agentId: accountCfg.agentId || 0,
    secret: accountCfg.secret,
    token: accountCfg.token || "",
    encodingAESKey: accountCfg.encodingAESKey || "",
    callbackPort: accountCfg.callbackPort,
    allowFrom: accountCfg.allowFrom,
  };
}

/**
 * 获取所有配置的企业微信账号
 */
export function getAllWeComAccounts(cfg: ClawdbotConfig): WeComAccount[] {
  const wecomCfg = cfg.channels?.wecom as WeComConfigEntry | undefined;
  if (!wecomCfg) return [];

  const accounts: WeComAccount[] = [];

  // 默认账号
  if (wecomCfg.corpId && wecomCfg.secret) {
    accounts.push({
      accountId: "default",
      corpId: wecomCfg.corpId,
      agentId: wecomCfg.agentId || 0,
      secret: wecomCfg.secret,
      token: wecomCfg.token || "",
      encodingAESKey: wecomCfg.encodingAESKey || "",
      callbackPort: wecomCfg.callbackPort,
      allowFrom: wecomCfg.allowFrom,
    });
  }

  // 多账号
  if (wecomCfg.accounts) {
    for (const [id, entryCfg] of Object.entries(wecomCfg.accounts)) {
      if (entryCfg?.corpId && entryCfg?.secret && id !== "default") {
        accounts.push({
          accountId: id,
          corpId: entryCfg.corpId,
          agentId: entryCfg.agentId || 0,
          secret: entryCfg.secret,
          token: entryCfg.token || "",
          encodingAESKey: entryCfg.encodingAESKey || "",
          callbackPort: entryCfg.callbackPort,
          allowFrom: entryCfg.allowFrom,
        });
      }
    }
  }

  return accounts;
}
