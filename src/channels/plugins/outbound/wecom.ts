/**
 * WeChat Work (企业微信) outbound adapter
 *
 * Supports both self-built application and customer service (KF) channels.
 */

import type { ChannelOutboundAdapter } from "../types.js";
import { sendWeComMessage, sendWeComMedia } from "../../../wecom/send.js";
import { sendWeComKfMessage, sendWeComKfMedia } from "../../../wecom/kf-send.js";
import { resolveWeComAccount } from "../../../wecom/accounts.js";
import { loadConfig } from "../../../config/config.js";
import { convertMarkdownForWeChat } from "../../../wecom/format.js";

/**
 * 分割长文本为多个 chunk
 *
 * 微信客服消息限制约 2048 字符，使用 1800 作为安全上限
 * 分割策略：
 * 1. 先按段落分割
 * 2. 合并短段落
 * 3. 确保每个 chunk 不超过限制
 * 4. 添加分页提示
 */
function splitTextIntoChunks(text: string, maxLength: number = 1800): string[] {
  if (!text || text.length <= maxLength) {
    return text ? [text] : [];
  }

  // 先按双换行分段
  let segments = text.split(/\n\n+/).filter(Boolean);

  // 如果只有一段且太长，按单换行分
  if (segments.length === 1 && segments[0].length > maxLength) {
    segments = text.split(/\n/).filter(Boolean);
  }

  // 如果还是单段且太长，按句子分
  if (segments.length === 1 && segments[0].length > maxLength) {
    segments = text.split(/(?<=[。！？.!?；;])\s*/).filter(Boolean);
  }

  // 合并短段落，同时确保不超过限制
  const merged: string[] = [];
  let buffer = "";

  for (const seg of segments) {
    // 如果单个段落就超过限制，需要强制截断
    if (seg.length > maxLength) {
      // 先保存 buffer
      if (buffer) {
        merged.push(buffer);
        buffer = "";
      }
      // 强制分割超长段落
      let remaining = seg;
      while (remaining.length > maxLength) {
        // 找合适的截断点
        let cutPoint = maxLength;
        const punctuations = ["。", "！", "？", ".", "!", "?", "，", ",", " "];
        for (const p of punctuations) {
          const idx = remaining.lastIndexOf(p, maxLength);
          if (idx > maxLength * 0.5) {
            cutPoint = idx + 1;
            break;
          }
        }
        merged.push(remaining.substring(0, cutPoint).trim());
        remaining = remaining.substring(cutPoint).trim();
      }
      if (remaining) {
        buffer = remaining;
      }
      continue;
    }

    // 正常合并逻辑
    if (buffer) {
      const combined = buffer + "\n\n" + seg;
      if (combined.length <= maxLength) {
        buffer = combined;
      } else {
        merged.push(buffer);
        buffer = seg;
      }
    } else {
      buffer = seg;
    }
  }

  if (buffer) {
    merged.push(buffer);
  }

  // 添加分页提示（不使用emoji，避免兼容性问题）
  if (merged.length > 1) {
    return merged.map((chunk, i) => {
      const pageInfo = `(${i + 1}/${merged.length})`;
      if (i === 0) {
        return `${chunk}\n\n${pageInfo} ...`;
      } else if (i === merged.length - 1) {
        return `${pageInfo}\n${chunk}`;
      } else {
        return `${pageInfo}\n${chunk}\n\n...`;
      }
    });
  }

  return merged.length > 0 ? merged : [text];
}

/**
 * Parse target to determine if it's KF (customer service) or self-built app
 */
function parseWeComTarget(to: string): {
  isKf: boolean;
  externalUserId?: string;
  openKfid?: string;
  userId?: string;
} {
  // KF target format: kf:<openKfid>:<external_userid>
  if (to.startsWith("kf:")) {
    const parts = to.split(":");
    if (parts.length >= 3) {
      return {
        isKf: true,
        openKfid: parts[1],
        externalUserId: parts.slice(2).join(":"),
      };
    }
  }

  // Self-built app target: just the user id
  return {
    isKf: false,
    userId: to,
  };
}

export const wecomOutbound: ChannelOutboundAdapter = {
  deliveryMode: "direct",
  textChunkLimit: 1800, // 微信客服消息限制约 2048，留余量
  chunker: splitTextIntoChunks,
  chunkerMode: "text",

  resolveTarget: ({ to }) => {
    if (!to?.trim()) {
      return { ok: false, error: new Error("Missing target for WeCom") };
    }
    return { ok: true, to: to.trim() };
  },

  sendText: async ({ to, text, accountId }) => {
    const cfg = loadConfig();
    const account = resolveWeComAccount(cfg, accountId || "default");

    if (!account) {
      throw new Error(`WeCom account not found: ${accountId || "default"}`);
    }

    const parsed = parseWeComTarget(to);
    const credentials = { corpId: account.corpId, secret: account.secret };

    // 将 Markdown 转换为微信友好格式
    const formattedText = convertMarkdownForWeChat(text);

    // Split text into chunks for human-like delivery
    const chunks = splitTextIntoChunks(formattedText);

    let lastResult: { messageId?: string; chatId?: string } = { chatId: to };

    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i];
      if (!chunk.trim()) continue;

      if (parsed.isKf && parsed.openKfid && parsed.externalUserId) {
        // Customer service channel
        const result = await sendWeComKfMessage({
          credentials,
          toUser: parsed.externalUserId,
          openKfid: parsed.openKfid,
          content: chunk,
        });
        if (result.msgid) {
          lastResult = { messageId: result.msgid, chatId: to };
        }
      } else if (parsed.userId) {
        // Self-built app channel
        const result = await sendWeComMessage({
          credentials,
          agentId: account.agentId,
          toUser: parsed.userId,
          content: chunk,
        });
        if (result.msgid) {
          lastResult = { messageId: result.msgid, chatId: to };
        }
      }

      // Add delay between chunks for human-like delivery
      if (i < chunks.length - 1) {
        const delay = Math.min(300 + chunk.length * 10, 2000);
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }

    return {
      channel: "wecom" as const,
      messageId: lastResult.messageId ?? "unknown",
      chatId: lastResult.chatId,
    };
  },

  sendMedia: async ({ to, text, mediaUrl, accountId }) => {
    const cfg = loadConfig();
    const account = resolveWeComAccount(cfg, accountId || "default");

    if (!account) {
      throw new Error(`WeCom account not found: ${accountId || "default"}`);
    }

    const parsed = parseWeComTarget(to);
    const credentials = { corpId: account.corpId, secret: account.secret };

    // 将 Markdown 转换为微信友好格式
    const formattedText = text ? convertMarkdownForWeChat(text) : undefined;

    let result: { messageId?: string; chatId?: string } = { chatId: to };

    if (parsed.isKf && parsed.openKfid && parsed.externalUserId) {
      // Customer service channel
      if (mediaUrl) {
        const mediaResult = await sendWeComKfMedia({
          credentials,
          toUser: parsed.externalUserId,
          openKfid: parsed.openKfid,
          mediaUrl,
          caption: formattedText,
        });
        if (mediaResult.msgid) {
          result = { messageId: mediaResult.msgid, chatId: to };
        }
      } else if (formattedText) {
        const textResult = await sendWeComKfMessage({
          credentials,
          toUser: parsed.externalUserId,
          openKfid: parsed.openKfid,
          content: formattedText,
        });
        if (textResult.msgid) {
          result = { messageId: textResult.msgid, chatId: to };
        }
      }
    } else if (parsed.userId) {
      // Self-built app channel
      if (mediaUrl) {
        const mediaResult = await sendWeComMedia({
          credentials,
          agentId: account.agentId,
          toUser: parsed.userId,
          mediaUrl,
          caption: formattedText,
        });
        if (mediaResult.msgid) {
          result = { messageId: mediaResult.msgid, chatId: to };
        }
      } else if (formattedText) {
        const textResult = await sendWeComMessage({
          credentials,
          agentId: account.agentId,
          toUser: parsed.userId,
          content: formattedText,
        });
        if (textResult.msgid) {
          result = { messageId: textResult.msgid, chatId: to };
        }
      }
    }

    return {
      channel: "wecom" as const,
      messageId: result.messageId ?? "unknown",
      chatId: result.chatId,
    };
  },

  sendPayload: async ({ to, payload, accountId }) => {
    const cfg = loadConfig();
    const account = resolveWeComAccount(cfg, accountId || "default");

    if (!account) {
      throw new Error(`WeCom account not found: ${accountId || "default"}`);
    }

    const parsed = parseWeComTarget(to);
    const credentials = { corpId: account.corpId, secret: account.secret };

    // Handle media URLs first
    const mediaUrls = payload.mediaUrls?.length
      ? payload.mediaUrls
      : payload.mediaUrl
        ? [payload.mediaUrl]
        : [];

    let lastResult: { messageId?: string; chatId?: string } = { chatId: to };

    // Send media
    for (const mediaUrl of mediaUrls) {
      if (parsed.isKf && parsed.openKfid && parsed.externalUserId) {
        const result = await sendWeComKfMedia({
          credentials,
          toUser: parsed.externalUserId,
          openKfid: parsed.openKfid,
          mediaUrl,
        });
        if (result.msgid) {
          lastResult = { messageId: result.msgid, chatId: to };
        }
      } else if (parsed.userId) {
        const result = await sendWeComMedia({
          credentials,
          agentId: account.agentId,
          toUser: parsed.userId,
          mediaUrl,
        });
        if (result.msgid) {
          lastResult = { messageId: result.msgid, chatId: to };
        }
      }
      // Delay between media
      await new Promise((resolve) => setTimeout(resolve, 300));
    }

    // Send text in chunks (将 Markdown 转换为微信友好格式)
    if (payload.text) {
      const formattedText = convertMarkdownForWeChat(payload.text);
      const chunks = splitTextIntoChunks(formattedText);

      for (let i = 0; i < chunks.length; i++) {
        const chunk = chunks[i];
        if (!chunk.trim()) continue;

        if (parsed.isKf && parsed.openKfid && parsed.externalUserId) {
          const result = await sendWeComKfMessage({
            credentials,
            toUser: parsed.externalUserId,
            openKfid: parsed.openKfid,
            content: chunk,
          });
          if (result.msgid) {
            lastResult = { messageId: result.msgid, chatId: to };
          }
        } else if (parsed.userId) {
          const result = await sendWeComMessage({
            credentials,
            agentId: account.agentId,
            toUser: parsed.userId,
            content: chunk,
          });
          if (result.msgid) {
            lastResult = { messageId: result.msgid, chatId: to };
          }
        }

        // Delay between chunks
        if (i < chunks.length - 1) {
          const delay = Math.min(300 + chunk.length * 10, 2000);
          await new Promise((resolve) => setTimeout(resolve, delay));
        }
      }
    }

    return {
      channel: "wecom" as const,
      messageId: lastResult.messageId ?? "unknown",
      chatId: lastResult.chatId,
    };
  },
};
