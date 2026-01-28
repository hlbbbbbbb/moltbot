/**
 * WeChat Work (企业微信) message actions adapter
 *
 * Enables the AI to use the message tool for sending messages to WeCom channels.
 */

import { readStringParam, jsonResult } from "../../../agents/tools/common.js";
import { sendWeComMessage, sendWeComMedia } from "../../../wecom/send.js";
import { sendWeComKfMessage, sendWeComKfMedia } from "../../../wecom/kf-send.js";
import { resolveWeComAccount } from "../../../wecom/accounts.js";
import type { ChannelMessageActionAdapter, ChannelMessageActionName } from "../types.js";

const providerId = "wecom";

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

function readWeComSendParams(params: Record<string, unknown>) {
  // Support multiple parameter names for target
  const to =
    readStringParam(params, "to") ??
    readStringParam(params, "target") ??
    readStringParam(params, "toUser", { required: true });

  const mediaUrl = readStringParam(params, "media", { trim: false });
  const message = readStringParam(params, "message", { allowEmpty: true });
  const caption = readStringParam(params, "caption", { allowEmpty: true });
  const content = message || caption || "";
  const filePath = readStringParam(params, "filePath") ?? readStringParam(params, "path");

  return {
    to,
    content,
    mediaUrl: mediaUrl ?? filePath ?? undefined,
  };
}

export const wecomMessageActions: ChannelMessageActionAdapter = {
  listActions: ({ cfg }) => {
    // Check if WeCom is configured
    const wecomCfg = cfg.channels?.wecom as Record<string, unknown> | undefined;
    if (!wecomCfg) return [];

    // Check if enabled
    const enabled = wecomCfg.enabled !== false;
    if (!enabled) return [];

    const actions: ChannelMessageActionName[] = ["send"];
    return actions;
  },

  supportsButtons: () => false,
  supportsCards: () => false,

  extractToolSend: ({ args }) => {
    const action = typeof args.action === "string" ? args.action.trim() : "";
    if (action !== "send") return null;

    const to =
      typeof args.to === "string"
        ? args.to
        : typeof args.target === "string"
          ? args.target
          : typeof args.toUser === "string"
            ? args.toUser
            : undefined;

    if (!to) return null;

    const accountId = typeof args.accountId === "string" ? args.accountId.trim() : undefined;
    return { to, accountId };
  },

  handleAction: async ({ action, params, cfg, accountId }) => {
    if (action === "send") {
      const { to, content, mediaUrl } = readWeComSendParams(params);
      const account = resolveWeComAccount(cfg, accountId || "default");

      if (!account) {
        throw new Error(`WeCom account not found: ${accountId || "default"}`);
      }

      const parsed = parseWeComTarget(to);
      const credentials = { corpId: account.corpId, secret: account.secret };

      // Send media if provided
      if (mediaUrl) {
        if (parsed.isKf && parsed.openKfid && parsed.externalUserId) {
          const result = await sendWeComKfMedia({
            credentials,
            toUser: parsed.externalUserId,
            openKfid: parsed.openKfid,
            mediaUrl,
            caption: content,
          });
          return jsonResult({
            ok: result.success,
            messageId: result.msgid,
            channel: providerId,
          });
        } else if (parsed.userId) {
          const result = await sendWeComMedia({
            credentials,
            agentId: account.agentId,
            toUser: parsed.userId,
            mediaUrl,
            caption: content,
          });
          return jsonResult({
            ok: result.success,
            messageId: result.msgid,
            channel: providerId,
          });
        }
      }

      // Send text message
      if (content) {
        if (parsed.isKf && parsed.openKfid && parsed.externalUserId) {
          const result = await sendWeComKfMessage({
            credentials,
            toUser: parsed.externalUserId,
            openKfid: parsed.openKfid,
            content,
          });
          return jsonResult({
            ok: result.success,
            messageId: result.msgid,
            channel: providerId,
          });
        } else if (parsed.userId) {
          const result = await sendWeComMessage({
            credentials,
            agentId: account.agentId,
            toUser: parsed.userId,
            content,
          });
          return jsonResult({
            ok: result.success,
            messageId: result.msgid,
            channel: providerId,
          });
        }
      }

      throw new Error("No content or media to send");
    }

    throw new Error(`Action ${action} is not supported for provider ${providerId}.`);
  },
};
