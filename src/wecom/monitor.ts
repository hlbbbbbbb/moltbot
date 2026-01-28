/**
 * 企业微信消息监听器
 *
 * 接收企业微信消息并分发给 AI 处理
 */

import { createSubsystemLogger } from "../logging/subsystem.js";
import type { ClawdbotConfig } from "../config/config.js";
import { loadConfig } from "../config/config.js";
import type { MsgContext } from "../auto-reply/templating.js";
import { getReplyFromConfig } from "../auto-reply/reply/get-reply.js";
import { resolveWeComAccount, type WeComAccount } from "./accounts.js";
import { WeComCallbackServer, type WeComInboundMessage } from "./callback.js";
import { sendWeComMessage } from "./send.js";
import { monitorWeComKfChannel } from "./kf-monitor.js";

const log = createSubsystemLogger("gateway/channels/wecom");

// 企业微信配置类型
interface WeComKfConfig {
  enabled?: boolean;
  openKfid?: string;
  pollIntervalMs?: number;
}

export interface WeComMonitorOptions {
  accountId?: string;
  config?: ClawdbotConfig;
  runtime?: unknown;
  abortSignal?: AbortSignal;
}

export interface WeComMonitorResult {
  close: () => Promise<void>;
}

/**
 * 启动企业微信消息监听
 */
export async function monitorWeComChannel(
  options: WeComMonitorOptions = {},
): Promise<WeComMonitorResult> {
  const { accountId = "default", config, abortSignal } = options;

  // 加载配置
  const cfg = config ?? loadConfig();

  // 解析账号配置
  const account = resolveWeComAccount(cfg, accountId);

  if (!account) {
    throw new Error(`未找到企业微信账号配置: ${accountId}`);
  }

  log.info(
    `启动企业微信监听 accountId=${accountId} corpId=${account.corpId} agentId=${account.agentId}`,
  );

  // 创建回调服务器
  const callbackServer = new WeComCallbackServer({
    port: account.callbackPort || 3000,
    token: account.token,
    encodingAESKey: account.encodingAESKey,
    corpId: account.corpId,
  });

  // 处理中止信号
  if (abortSignal) {
    abortSignal.addEventListener("abort", () => {
      callbackServer.stop().catch((err) => {
        log.error(`停止回调服务器失败: ${String(err)}`);
      });
    });
  }

  // 监听消息
  callbackServer.on("message", async (msg: WeComInboundMessage) => {
    // 检查是否允许的发送者
    if (account.allowFrom && account.allowFrom.length > 0) {
      if (!account.allowFrom.includes(msg.from)) {
        log.info(`发送者不在允许列表中 from=${msg.from}`);
        return;
      }
    }

    // 只处理文本消息
    if (msg.msgType !== "text") {
      log.info(`跳过非文本消息 msgType=${msg.msgType}`);
      return;
    }

    log.info(`收到消息 from=${msg.from} content=${msg.content.substring(0, 50)}`);

    try {
      // 构建消息上下文
      const sessionKey = `wecom:dm:${msg.from}`;

      const ctx: MsgContext = {
        Body: msg.content,
        From: msg.from,
        To: account.corpId,
        SessionKey: sessionKey,
        AccountId: account.accountId,
        Provider: "wecom",
        Surface: "wecom",
        ChatType: "dm",
        Timestamp: msg.timestamp.getTime(),
        MessageSid: msg.id,
        OriginatingChannel: "wecom" as const,
        OriginatingTo: msg.from,
      };

      // 获取 AI 回复
      log.info(`正在获取 AI 回复...`);
      const reply = await getReplyFromConfig(ctx, {}, cfg);

      // 处理回复
      if (reply) {
        const replies = Array.isArray(reply) ? reply : [reply];

        for (const r of replies) {
          if (r.text) {
            log.info(`发送回复 to=${msg.from} length=${r.text.length}`);

            await sendWeComMessage({
              credentials: {
                corpId: account.corpId,
                secret: account.secret,
              },
              agentId: account.agentId,
              toUser: msg.from,
              content: r.text,
            });
          }
        }
      } else {
        log.info(`未获取到 AI 回复`);
      }
    } catch (error) {
      log.error(`处理消息失败: ${String(error)}`);
    }
  });

  // 启动服务器
  await callbackServer.start();

  log.info(`企业微信监听已启动 port=${account.callbackPort || 3000}`);

  // 检查是否启用客服功能
  const wecomCfg = cfg.channels?.wecom as Record<string, unknown> | undefined;
  const kfConfig = wecomCfg?.kf as WeComKfConfig | undefined;
  let kfMonitor: WeComMonitorResult | null = null;

  if (kfConfig?.enabled && kfConfig?.openKfid) {
    log.info(`启动微信客服监听 openKfid=${kfConfig.openKfid}`);
    try {
      kfMonitor = await monitorWeComKfChannel({
        accountId,
        openKfid: kfConfig.openKfid,
        config: cfg,
        abortSignal,
      });
    } catch (err) {
      log.error(`启动微信客服监听失败: ${String(err)}`);
    }
  }

  return {
    close: async () => {
      await callbackServer.stop();
      if (kfMonitor) {
        await kfMonitor.close();
      }
      log.info("企业微信监听已停止");
    },
  };
}
