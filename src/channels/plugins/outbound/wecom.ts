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

/**
 * Split text into chunks for human-like delivery
 */
function splitTextIntoChunks(text: string, maxLength: number = 2000): string[] {
  // First try to split by double newlines (paragraphs)
  let segments = text.split(/\n\n+/).filter(Boolean);

  // If only one segment and too long, split by single newlines
  if (segments.length === 1 && segments[0].length > 200) {
    segments = text.split(/\n/).filter(Boolean);
  }

  // If still only one segment and too long, split by punctuation
  if (segments.length === 1 && segments[0].length > 300) {
    segments = text.split(/(?<=[。！？.!?])\s*/).filter(Boolean);
  }

  // Merge short segments
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

  // Limit to 10 chunks max
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
  textChunkLimit: 2000,
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

    // Split text into chunks for human-like delivery
    const chunks = splitTextIntoChunks(text);

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

    let result: { messageId?: string; chatId?: string } = { chatId: to };

    if (parsed.isKf && parsed.openKfid && parsed.externalUserId) {
      // Customer service channel
      if (mediaUrl) {
        const mediaResult = await sendWeComKfMedia({
          credentials,
          toUser: parsed.externalUserId,
          openKfid: parsed.openKfid,
          mediaUrl,
          caption: text,
        });
        if (mediaResult.msgid) {
          result = { messageId: mediaResult.msgid, chatId: to };
        }
      } else if (text) {
        const textResult = await sendWeComKfMessage({
          credentials,
          toUser: parsed.externalUserId,
          openKfid: parsed.openKfid,
          content: text,
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
          caption: text,
        });
        if (mediaResult.msgid) {
          result = { messageId: mediaResult.msgid, chatId: to };
        }
      } else if (text) {
        const textResult = await sendWeComMessage({
          credentials,
          agentId: account.agentId,
          toUser: parsed.userId,
          content: text,
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

    // Send text in chunks
    if (payload.text) {
      const chunks = splitTextIntoChunks(payload.text);

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
