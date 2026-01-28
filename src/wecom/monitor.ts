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
import { sendWeComMessage, sendWeComMedia } from "./send.js";
import type { ReplyPayload } from "../auto-reply/types.js";
import { monitorWeComKfChannel } from "./kf-monitor.js";

const log = createSubsystemLogger("gateway/channels/wecom");

import type { WeComCredentials } from "./token.js";

/**
 * 发送 ReplyPayload 到企业微信自建应用（支持分段发送）
 */
async function sendReplyPayloadToWecom(params: {
  payload: ReplyPayload;
  credentials: WeComCredentials;
  agentId: number;
  toUser: string;
}): Promise<void> {
  const { payload, credentials, agentId, toUser } = params;

  // 处理媒体 URL（单个或多个）
  const mediaUrls = payload.mediaUrls || (payload.mediaUrl ? [payload.mediaUrl] : []);

  for (const mediaUrl of mediaUrls) {
    log.info(`发送媒体 to=${toUser} url=${mediaUrl.substring(0, 80)}`);
    await sendWeComMedia({
      credentials,
      agentId,
      toUser,
      mediaUrl,
    });
    // 媒体之间短暂延迟
    await new Promise((resolve) => setTimeout(resolve, 300));
  }

  // 发送文本（支持分段发送，模拟人类一句一句发）
  if (payload.text) {
    // 按双换行或单换行分割成多段
    const segments = splitTextIntoSegments(payload.text);

    for (let i = 0; i < segments.length; i++) {
      const segment = segments[i];
      if (!segment.trim()) continue;

      log.info(`发送回复 [${i + 1}/${segments.length}] to=${toUser} length=${segment.length}`);
      await sendWeComMessage({
        credentials,
        agentId,
        toUser,
        content: segment,
      });

      // 模拟人类打字，每段之间短暂延迟（除了最后一段）
      if (i < segments.length - 1) {
        const delay = Math.min(300 + segment.length * 10, 2000);
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
  }
}

/**
 * 将文本分割成多个段落，用于模拟人类一句一句发送
 */
function splitTextIntoSegments(text: string): string[] {
  // 首先尝试按双换行分割（段落分隔）
  let segments = text.split(/\n\n+/).filter(Boolean);

  // 如果只有一段且太长（超过 200 字），尝试按单换行分割
  if (segments.length === 1 && segments[0].length > 200) {
    segments = text.split(/\n/).filter(Boolean);
  }

  // 如果还是只有一段且太长，按句号/问号/感叹号分割
  if (segments.length === 1 && segments[0].length > 300) {
    segments = text.split(/(?<=[。！？.!?])\s*/).filter(Boolean);
  }

  // 合并过短的段落（少于 10 个字符的合并到下一段）
  const merged: string[] = [];
  let buffer = "";

  for (const seg of segments) {
    if (buffer) {
      buffer += "\n" + seg;
      if (buffer.length >= 20) {
        merged.push(buffer);
        buffer = "";
      }
    } else if (seg.length < 10 && merged.length > 0) {
      // 太短的段落合并到上一段
      merged[merged.length - 1] += "\n" + seg;
    } else if (seg.length < 10) {
      buffer = seg;
    } else {
      merged.push(seg);
    }
  }

  if (buffer) {
    if (merged.length > 0) {
      merged[merged.length - 1] += "\n" + buffer;
    } else {
      merged.push(buffer);
    }
  }

  // 限制最多 10 段（防止太多消息）
  if (merged.length > 10) {
    const result: string[] = [];
    const perChunk = Math.ceil(merged.length / 10);
    for (let i = 0; i < merged.length; i += perChunk) {
      result.push(merged.slice(i, i + perChunk).join("\n\n"));
    }
    return result;
  }

  return merged.length > 0 ? merged : [text];
}

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
        // 启用命令处理
        CommandAuthorized: true,
      };

      // 获取 AI 回复
      log.info(`正在获取 AI 回复...`);
      const reply = await getReplyFromConfig(ctx, {}, cfg);

      // 处理回复
      if (reply) {
        const replies = Array.isArray(reply) ? reply : [reply];

        for (const r of replies) {
          await sendReplyPayloadToWecom({
            payload: r,
            credentials: { corpId: account.corpId, secret: account.secret },
            agentId: account.agentId,
            toUser: msg.from,
          });
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
