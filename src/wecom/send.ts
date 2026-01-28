/**
 * 企业微信发送消息
 */

import { createSubsystemLogger } from "../logging/subsystem.js";
import { getWeComAccessToken, type WeComCredentials } from "./token.js";

const log = createSubsystemLogger("gateway/channels/wecom").child("send");

export interface WeComSendOptions {
  credentials: WeComCredentials;
  agentId: number;
  toUser: string;
  content: string;
  msgType?: "text" | "markdown";
}

export interface WeComSendResult {
  success: boolean;
  errcode?: number;
  errmsg?: string;
  msgid?: string;
}

/**
 * 发送文本消息
 */
export async function sendWeComMessage(options: WeComSendOptions): Promise<WeComSendResult> {
  const { credentials, agentId, toUser, content, msgType = "text" } = options;

  try {
    const token = await getWeComAccessToken(credentials);
    const url = `https://qyapi.weixin.qq.com/cgi-bin/message/send?access_token=${token}`;

    // 分割长消息（企业微信文本消息限制 2048 字节）
    const maxLength = 2000;
    const chunks = splitMessage(content, maxLength);

    let lastResult: WeComSendResult = { success: false };

    for (const chunk of chunks) {
      const body =
        msgType === "markdown"
          ? {
              touser: toUser,
              msgtype: "markdown",
              agentid: agentId,
              markdown: { content: chunk },
            }
          : {
              touser: toUser,
              msgtype: "text",
              agentid: agentId,
              text: { content: chunk },
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
        log.error(`发送消息失败 errcode=${data.errcode} errmsg=${data.errmsg}`);
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

    log.info(`消息发送成功 toUser=${toUser} length=${content.length} chunks=${chunks.length}`);
    return lastResult;
  } catch (error) {
    log.error(`发送消息异常: ${String(error)}`);
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

    // 尝试在换行处分割
    let splitIndex = remaining.lastIndexOf("\n", maxLength);
    if (splitIndex === -1 || splitIndex < maxLength * 0.5) {
      // 没有合适的换行点，在空格处分割
      splitIndex = remaining.lastIndexOf(" ", maxLength);
      if (splitIndex === -1 || splitIndex < maxLength * 0.5) {
        // 强制分割
        splitIndex = maxLength;
      }
    }

    chunks.push(remaining.substring(0, splitIndex));
    remaining = remaining.substring(splitIndex).trim();
  }

  return chunks;
}
