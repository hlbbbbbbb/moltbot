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

export interface WeComKfSendMediaOptions {
  credentials: WeComCredentials;
  toUser: string;
  openKfid: string;
  mediaUrl: string;
  caption?: string;
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

/**
 * 根据 URL 或 MIME 类型判断媒体类型
 */
function detectMediaType(url: string, contentType?: string): "image" | "video" | "file" {
  const urlLower = url.toLowerCase();

  // 先检查 content-type
  if (contentType) {
    if (contentType.startsWith("image/")) return "image";
    if (contentType.startsWith("video/")) return "video";
  }

  // 再检查文件扩展名
  if (/\.(jpg|jpeg|png|gif|webp|bmp)(\?|$)/i.test(urlLower)) return "image";
  if (/\.(mp4|mov|avi|wmv|webm|mkv)(\?|$)/i.test(urlLower)) return "video";

  return "file";
}

/**
 * 上传临时素材到企业微信
 */
async function uploadMedia(
  credentials: WeComCredentials,
  mediaUrl: string,
  mediaType: "image" | "video" | "file",
): Promise<{ media_id: string } | null> {
  try {
    const token = await getWeComAccessToken(credentials);

    // 下载媒体文件
    log.info(`下载媒体文件 url=${mediaUrl.substring(0, 100)}`);
    const response = await fetch(mediaUrl);
    if (!response.ok) {
      log.error(`下载媒体文件失败 status=${response.status}`);
      return null;
    }

    const contentType = response.headers.get("content-type") || "application/octet-stream";
    const buffer = Buffer.from(await response.arrayBuffer());

    // 提取文件名
    const urlPath = new URL(mediaUrl).pathname;
    let fileName = urlPath.split("/").pop() || "media";
    if (!fileName.includes(".")) {
      // 添加扩展名
      const ext = contentType.split("/")[1]?.split(";")[0] || "bin";
      fileName = `${fileName}.${ext}`;
    }

    // 构建 multipart/form-data
    const boundary = `----WeComBoundary${Date.now()}`;
    const parts: Buffer[] = [];

    parts.push(
      Buffer.from(
        `--${boundary}\r\n` +
          `Content-Disposition: form-data; name="media"; filename="${fileName}"\r\n` +
          `Content-Type: ${contentType}\r\n\r\n`,
      ),
    );
    parts.push(buffer);
    parts.push(Buffer.from(`\r\n--${boundary}--\r\n`));

    const body = Buffer.concat(parts);

    // 上传到企业微信
    const uploadUrl = `https://qyapi.weixin.qq.com/cgi-bin/media/upload?access_token=${token}&type=${mediaType}`;

    log.info(`上传媒体到企业微信 type=${mediaType} size=${buffer.length}`);
    const uploadResponse = await fetch(uploadUrl, {
      method: "POST",
      headers: {
        "Content-Type": `multipart/form-data; boundary=${boundary}`,
      },
      body,
    });

    const result = (await uploadResponse.json()) as {
      errcode?: number;
      errmsg?: string;
      media_id?: string;
    };

    if (result.errcode && result.errcode !== 0) {
      log.error(`上传媒体失败 errcode=${result.errcode} errmsg=${result.errmsg}`);
      return null;
    }

    log.info(`上传媒体成功 media_id=${result.media_id}`);
    return { media_id: result.media_id! };
  } catch (error) {
    log.error(`上传媒体异常: ${String(error)}`);
    return null;
  }
}

/**
 * 发送客服媒体消息（图片/视频）
 */
export async function sendWeComKfMedia(
  options: WeComKfSendMediaOptions,
): Promise<WeComKfSendResult> {
  const { credentials, toUser, openKfid, mediaUrl, caption } = options;

  try {
    // 检测媒体类型
    const mediaType = detectMediaType(mediaUrl);

    // 上传媒体
    const uploadResult = await uploadMedia(credentials, mediaUrl, mediaType);
    if (!uploadResult) {
      // 上传失败，发送链接作为文本
      log.info(`媒体上传失败，发送链接`);
      const text = caption ? `${caption}\n\n${mediaUrl}` : mediaUrl;
      return sendWeComKfMessage({
        credentials,
        toUser,
        openKfid,
        content: text,
      });
    }

    const token = await getWeComAccessToken(credentials);
    const url = `https://qyapi.weixin.qq.com/cgi-bin/kf/send_msg?access_token=${token}`;

    // 构建消息体
    const body: Record<string, unknown> = {
      touser: toUser,
      open_kfid: openKfid,
      msgtype: mediaType,
      [mediaType]: {
        media_id: uploadResult.media_id,
      },
    };

    log.info(`发送客服媒体消息 type=${mediaType} to=${toUser}`);
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
      log.error(`发送客服媒体失败 errcode=${data.errcode} errmsg=${data.errmsg}`);
      return {
        success: false,
        errcode: data.errcode,
        errmsg: data.errmsg,
      };
    }

    // 如果有 caption，单独发送文本
    if (caption) {
      await sendWeComKfMessage({
        credentials,
        toUser,
        openKfid,
        content: caption,
      });
    }

    log.info(`客服媒体发送成功 type=${mediaType}`);
    return {
      success: true,
      msgid: data.msgid,
    };
  } catch (error) {
    log.error(`发送客服媒体异常: ${String(error)}`);
    return {
      success: false,
      errmsg: String(error),
    };
  }
}
