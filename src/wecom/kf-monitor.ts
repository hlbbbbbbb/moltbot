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
import { sendWeComKfMessage, sendWeComKfMedia } from "./kf-send.js";
import type { ReplyPayload } from "../auto-reply/types.js";
import { downloadMedia } from "./kf-media.js";

const log = createSubsystemLogger("gateway/channels/wecom-kf");

import type { WeComCredentials } from "./token.js";

/**
 * 发送 ReplyPayload 到微信客服（支持分段发送）
 */
async function sendReplyPayload(params: {
  payload: ReplyPayload;
  credentials: WeComCredentials;
  toUser: string;
  openKfid: string;
}): Promise<void> {
  const { payload, credentials, toUser, openKfid } = params;

  // 处理媒体 URL（单个或多个）
  const mediaUrls = payload.mediaUrls || (payload.mediaUrl ? [payload.mediaUrl] : []);

  for (const mediaUrl of mediaUrls) {
    log.info(`发送媒体 to=${toUser} url=${mediaUrl.substring(0, 80)}`);
    await sendWeComKfMedia({
      credentials,
      toUser,
      openKfid,
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

      log.info(`发送文本回复 [${i + 1}/${segments.length}] to=${toUser} length=${segment.length}`);
      await sendWeComKfMessage({
        credentials,
        toUser,
        openKfid,
        content: segment,
      });

      // 模拟人类打字，每段之间短暂延迟（除了最后一段）
      if (i < segments.length - 1) {
        // 根据内容长度调整延迟，模拟真人打字
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
  let pollInterval = 10000; // 轮询间隔 10 秒（避免 API 频率限制）
  let consecutiveErrors = 0;

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
          consecutiveErrors = 0; // 重置错误计数

          // 更新游标
          if (result.next_cursor) {
            cursorStore.set(openKfid, result.next_cursor);
          }

          // 处理消息
          for (const msg of result.msg_list) {
            // 只处理客户发送的消息 (origin=3)
            if (msg.origin === 3) {
              // 文本消息
              if (msg.msgtype === "text" && msg.text?.content) {
                await processKfMessage({
                  msg,
                  account,
                  openKfid,
                  cfg,
                });
              }
              // 图片消息
              else if (msg.msgtype === "image" && msg.image?.media_id) {
                await processKfMediaMessage({
                  msg,
                  account,
                  openKfid,
                  cfg,
                  mediaType: "image",
                  mediaId: msg.image.media_id,
                });
              }
              // 视频消息
              else if (msg.msgtype === "video" && msg.video?.media_id) {
                await processKfMediaMessage({
                  msg,
                  account,
                  openKfid,
                  cfg,
                  mediaType: "video",
                  mediaId: msg.video.media_id,
                });
              }
              // 文件消息
              else if (msg.msgtype === "file" && msg.file?.media_id) {
                await processKfMediaMessage({
                  msg,
                  account,
                  openKfid,
                  cfg,
                  mediaType: "file",
                  mediaId: msg.file.media_id,
                });
              }
              // 语音消息
              else if (msg.msgtype === "voice" && msg.voice?.media_id) {
                await processKfMediaMessage({
                  msg,
                  account,
                  openKfid,
                  cfg,
                  mediaType: "voice",
                  mediaId: msg.voice.media_id,
                });
              }
            }
          }

          // 如果还有更多消息，短暂延迟后继续拉取
          if (result.has_more === 1) {
            await new Promise((resolve) => setTimeout(resolve, 1000));
            continue;
          }
        } else if (result.errcode === 45009) {
          // API 频率限制，使用指数退避
          consecutiveErrors++;
          const backoff = Math.min(pollInterval * Math.pow(2, consecutiveErrors), 120000);
          log.info(`API 频率限制，等待 ${backoff / 1000} 秒后重试`);
          await new Promise((resolve) => setTimeout(resolve, backoff));
          continue;
        }

        // 等待下一次轮询
        await new Promise((resolve) => setTimeout(resolve, pollInterval));
      } catch (error) {
        log.error(`轮询客服消息失败: ${String(error)}`);
        consecutiveErrors++;
        const backoff = Math.min(pollInterval * Math.pow(2, consecutiveErrors), 120000);
        await new Promise((resolve) => setTimeout(resolve, backoff));
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
        await sendReplyPayload({
          payload: r,
          credentials: { corpId: account.corpId, secret: account.secret },
          toUser: externalUserId,
          openKfid,
        });
      }
    } else {
      log.info(`未获取到 AI 回复`);
    }
  } catch (error) {
    log.error(`处理客服消息失败: ${String(error)}`);
  }
}

/**
 * 处理客服媒体消息（图片/视频/文件/语音）
 */
async function processKfMediaMessage(params: {
  msg: KfMessage;
  account: WeComAccount;
  openKfid: string;
  cfg: ClawdbotConfig;
  mediaType: "image" | "video" | "file" | "voice";
  mediaId: string;
}): Promise<void> {
  const { msg, account, openKfid, cfg, mediaType, mediaId } = params;
  const externalUserId = msg.external_userid;

  const mediaTypeNames: Record<string, string> = {
    image: "图片",
    video: "视频",
    file: "文件",
    voice: "语音",
  };
  const typeName = mediaTypeNames[mediaType] || "媒体";

  log.info(`收到客服${typeName}消息 from=${externalUserId} mediaId=${mediaId.substring(0, 20)}...`);

  try {
    // 下载媒体
    const media = await downloadMedia(
      { corpId: account.corpId, secret: account.secret },
      mediaId,
      mediaType,
    );

    if (!media) {
      log.error(`下载${typeName}失败`);
      await sendWeComKfMessage({
        credentials: { corpId: account.corpId, secret: account.secret },
        toUser: externalUserId,
        openKfid,
        content: `抱歉，无法处理这个${typeName}。`,
      });
      return;
    }

    // 构建消息上下文
    const sessionKey = `wecom-kf:${openKfid}:${externalUserId}`;

    const ctx: MsgContext = {
      Body: `[用户发送了${typeName}]`,
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
      CommandAuthorized: true,
      // 媒体信息
      MediaPath: media.path,
      MediaUrl: media.path,
      MediaType: media.contentType,
    };

    // 获取 AI 回复
    log.info(`正在处理${typeName}，获取 AI 回复...`);
    const reply = await getReplyFromConfig(ctx, {}, cfg);

    // 处理回复
    if (reply) {
      const replies = Array.isArray(reply) ? reply : [reply];

      for (const r of replies) {
        await sendReplyPayload({
          payload: r,
          credentials: { corpId: account.corpId, secret: account.secret },
          toUser: externalUserId,
          openKfid,
        });
      }
    } else {
      log.info(`未获取到 AI 回复`);
    }
  } catch (error) {
    log.error(`处理客服${typeName}消息失败: ${String(error)}`);
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
