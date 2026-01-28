/**
 * 微信客服消息监听器
 *
 * 接收微信客服消息并分发给 AI 处理
 */

import { createSubsystemLogger } from "../logging/subsystem.js";
import type { ClawdbotConfig } from "../config/config.js";
import { loadConfig } from "../config/config.js";
import type { MsgContext } from "../auto-reply/templating.js";
import { getReplyFromConfig } from "../auto-reply/reply/get-reply.js";
import { resolveWeComAccount, type WeComAccount } from "./accounts.js";
import { WeComCallbackServer, type WeComInboundMessage } from "./callback.js";
import { syncKfMessages, type KfMessage } from "./kf-sync.js";
import { sendWeComKfMessage } from "./kf-send.js";

const log = createSubsystemLogger("gateway/channels/wecom-kf");

export interface WeComKfMonitorOptions {
  accountId?: string;
  openKfid: string; // 客服账号 ID
  config?: ClawdbotConfig;
  runtime?: unknown;
  abortSignal?: AbortSignal;
}

export interface WeComKfMonitorResult {
  close: () => Promise<void>;
}

// 存储同步游标
const cursorStore = new Map<string, string>();

/**
 * 启动微信客服消息监听（轮询模式）
 */
export async function monitorWeComKfChannel(
  options: WeComKfMonitorOptions,
): Promise<WeComKfMonitorResult> {
  const { accountId = "default", openKfid, config, abortSignal } = options;

  // 加载配置
  const cfg = config ?? loadConfig();

  // 解析账号配置
  const account = resolveWeComAccount(cfg, accountId);

  if (!account) {
    throw new Error(`未找到企业微信账号配置: ${accountId}`);
  }

  log.info(`启动微信客服监听 accountId=${accountId} openKfid=${openKfid}`);

  let isRunning = true;
  let pollInterval = 3000; // 轮询间隔 3 秒

  // 处理中止信号
  if (abortSignal) {
    abortSignal.addEventListener("abort", () => {
      isRunning = false;
    });
  }

  // 轮询同步消息
  const pollMessages = async () => {
    while (isRunning) {
      try {
        const cursor = cursorStore.get(openKfid);

        const result = await syncKfMessages({
          credentials: {
            corpId: account.corpId,
            secret: account.secret,
          },
          cursor,
          open_kfid: openKfid,
          limit: 100,
        });

        if (result.errcode === 0 && result.msg_list) {
          // 更新游标
          if (result.next_cursor) {
            cursorStore.set(openKfid, result.next_cursor);
          }

          // 处理消息
          for (const msg of result.msg_list) {
            // 只处理客户发送的文本消息 (origin=3)
            if (msg.origin === 3 && msg.msgtype === "text" && msg.text?.content) {
              await processKfMessage({
                msg,
                account,
                openKfid,
                cfg,
              });
            }
          }

          // 如果还有更多消息，立即继续拉取
          if (result.has_more === 1) {
            continue;
          }
        }

        // 等待下一次轮询
        await new Promise((resolve) => setTimeout(resolve, pollInterval));
      } catch (error) {
        log.error(`轮询客服消息失败: ${String(error)}`);
        await new Promise((resolve) => setTimeout(resolve, pollInterval * 2));
      }
    }
  };

  // 启动轮询
  pollMessages().catch((err) => {
    log.error(`轮询任务异常退出: ${String(err)}`);
  });

  log.info(`微信客服监听已启动 openKfid=${openKfid}`);

  return {
    close: async () => {
      isRunning = false;
      log.info("微信客服监听已停止");
    },
  };
}

/**
 * 处理客服消息
 */
async function processKfMessage(params: {
  msg: KfMessage;
  account: WeComAccount;
  openKfid: string;
  cfg: ClawdbotConfig;
}): Promise<void> {
  const { msg, account, openKfid, cfg } = params;
  const content = msg.text?.content || "";
  const externalUserId = msg.external_userid;

  log.info(`收到客服消息 from=${externalUserId} content=${content.substring(0, 50)}`);

  try {
    // 构建消息上下文
    const sessionKey = `wecom-kf:${openKfid}:${externalUserId}`;

    const ctx: MsgContext = {
      Body: content,
      From: externalUserId,
      To: openKfid,
      SessionKey: sessionKey,
      AccountId: account.accountId,
      Provider: "wecom-kf",
      Surface: "wecom-kf",
      ChatType: "dm",
      Timestamp: msg.send_time * 1000,
      MessageSid: msg.msgid,
      OriginatingChannel: "wecom" as const,
      OriginatingTo: externalUserId,
    };

    // 获取 AI 回复
    log.info(`正在获取 AI 回复...`);
    const reply = await getReplyFromConfig(ctx, {}, cfg);

    // 处理回复
    if (reply) {
      const replies = Array.isArray(reply) ? reply : [reply];

      for (const r of replies) {
        if (r.text) {
          log.info(`发送客服回复 to=${externalUserId} length=${r.text.length}`);

          await sendWeComKfMessage({
            credentials: {
              corpId: account.corpId,
              secret: account.secret,
            },
            toUser: externalUserId,
            openKfid: openKfid,
            content: r.text,
          });
        }
      }
    } else {
      log.info(`未获取到 AI 回复`);
    }
  } catch (error) {
    log.error(`处理客服消息失败: ${String(error)}`);
  }
}

/**
 * 基于回调的客服监听（需要配置回调 URL）
 */
export async function monitorWeComKfWithCallback(
  options: WeComKfMonitorOptions & {
    callbackPort?: number;
  },
): Promise<WeComKfMonitorResult> {
  const { accountId = "default", openKfid, config, abortSignal, callbackPort = 3000 } = options;

  const cfg = config ?? loadConfig();
  const account = resolveWeComAccount(cfg, accountId);

  if (!account) {
    throw new Error(`未找到企业微信账号配置: ${accountId}`);
  }

  log.info(`启动微信客服监听(回调模式) accountId=${accountId} openKfid=${openKfid}`);

  // 创建回调服务器
  const callbackServer = new WeComCallbackServer({
    port: callbackPort,
    path: "/wecom/kf/callback",
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

  // 监听消息事件
  callbackServer.on("message", async (msg: WeComInboundMessage) => {
    // 客服消息回调是事件通知，需要主动拉取消息
    if (msg.msgType === "event") {
      log.info(`收到客服事件通知，开始同步消息...`);

      // 同步消息
      const cursor = cursorStore.get(openKfid);
      const result = await syncKfMessages({
        credentials: {
          corpId: account.corpId,
          secret: account.secret,
        },
        cursor,
        open_kfid: openKfid,
      });

      if (result.errcode === 0 && result.msg_list) {
        if (result.next_cursor) {
          cursorStore.set(openKfid, result.next_cursor);
        }

        for (const kfMsg of result.msg_list) {
          if (kfMsg.origin === 3 && kfMsg.msgtype === "text" && kfMsg.text?.content) {
            await processKfMessage({
              msg: kfMsg,
              account,
              openKfid,
              cfg,
            });
          }
        }
      }
    }
  });

  // 启动服务器
  await callbackServer.start();

  log.info(`微信客服监听(回调模式)已启动 port=${callbackPort}`);

  return {
    close: async () => {
      await callbackServer.stop();
      log.info("微信客服监听已停止");
    },
  };
}
