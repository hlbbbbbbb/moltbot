/**
 * 微信客服发送消息
 */

import { createSubsystemLogger } from "../logging/subsystem.js";
import { getWeComAccessToken, type WeComCredentials } from "./token.js";

const log = createSubsystemLogger("gateway/channels/wecom").child("kf-send");

export interface WeComKfSendOptions {
  credentials: WeComCredentials;
  toUser: string; // external_userid
  openKfid: string; // 客服账号 ID
  content: string;
  msgType?: "text" | "markdown";
}

export interface WeComKfSendResult {
  success: boolean;
  errcode?: number;
  errmsg?: string;
  msgid?: string;
}

/**
 * 发送客服消息
 */
export async function sendWeComKfMessage(options: WeComKfSendOptions): Promise<WeComKfSendResult> {
  const { credentials, toUser, openKfid, content, msgType = "text" } = options;

  try {
    const token = await getWeComAccessToken(credentials);
    const url = `https://qyapi.weixin.qq.com/cgi-bin/kf/send_msg?access_token=${token}`;

    // 分割长消息
    const maxLength = 2000;
    const chunks = splitMessage(content, maxLength);

    let lastResult: WeComKfSendResult = { success: false };

    for (const chunk of chunks) {
      const body = {
        touser: toUser,
        open_kfid: openKfid,
        msgtype: msgType,
        [msgType]: { content: chunk },
      };

      const response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

      const data = (await response.json()) as {
        errcode?: number;
        errmsg?: string;
        msgid?: string;
      };

      if (data.errcode && data.errcode !== 0) {
        log.error(`发送客服消息失败 errcode=${data.errcode} errmsg=${data.errmsg}`);
        return {
          success: false,
          errcode: data.errcode,
          errmsg: data.errmsg,
        };
      }

      lastResult = {
        success: true,
        msgid: data.msgid,
      };

      // 多条消息之间短暂延迟
      if (chunks.length > 1) {
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
    }

    log.info(`客服消息发送成功 toUser=${toUser} length=${content.length}`);
    return lastResult;
  } catch (error) {
    log.error(`发送客服消息异常: ${String(error)}`);
    return {
      success: false,
      errmsg: String(error),
    };
  }
}

/**
 * 分割长消息
 */
function splitMessage(message: string, maxLength: number): string[] {
  const chunks: string[] = [];
  let remaining = message;

  while (remaining.length > 0) {
    if (remaining.length <= maxLength) {
      chunks.push(remaining);
      break;
    }

    let splitIndex = remaining.lastIndexOf("\n", maxLength);
    if (splitIndex === -1 || splitIndex < maxLength * 0.5) {
      splitIndex = remaining.lastIndexOf(" ", maxLength);
      if (splitIndex === -1 || splitIndex < maxLength * 0.5) {
        splitIndex = maxLength;
      }
    }

    chunks.push(remaining.substring(0, splitIndex));
    remaining = remaining.substring(splitIndex).trim();
  }

  return chunks;
}
