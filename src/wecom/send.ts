/**
 * 企业微信发送消息
 */

import fs from "node:fs";
import path from "node:path";

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

export interface WeComSendMediaOptions {
  credentials: WeComCredentials;
  agentId: number;
  toUser: string;
  mediaUrl: string;
  caption?: string;
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

/**
 * 根据 URL 判断媒体类型
 */
function detectMediaType(url: string): "image" | "video" | "file" {
  const urlLower = url.toLowerCase();
  if (/\.(jpg|jpeg|png|gif|webp|bmp)(\?|$)/i.test(urlLower)) return "image";
  if (/\.(mp4|mov|avi|wmv|webm|mkv)(\?|$)/i.test(urlLower)) return "video";
  return "file";
}

/**
 * 上传临时素材
 */
async function uploadMedia(
  credentials: WeComCredentials,
  mediaUrl: string,
  mediaType: "image" | "video" | "file",
): Promise<{ media_id: string } | null> {
  try {
    const token = await getWeComAccessToken(credentials);

    let buffer: Buffer;
    let contentType: string;
    let fileName: string;

    // 判断是本地文件还是 URL
    const isLocalFile = !mediaUrl.startsWith("http://") && !mediaUrl.startsWith("https://");

    if (isLocalFile) {
      // 本地文件
      log.info(`读取本地媒体文件 path=${mediaUrl}`);
      if (!fs.existsSync(mediaUrl)) {
        log.error(`本地文件不存在 path=${mediaUrl}`);
        return null;
      }
      buffer = fs.readFileSync(mediaUrl);
      fileName = path.basename(mediaUrl);
      // 根据扩展名推断 content-type
      const ext = path.extname(mediaUrl).toLowerCase();
      const mimeTypes: Record<string, string> = {
        ".jpg": "image/jpeg",
        ".jpeg": "image/jpeg",
        ".png": "image/png",
        ".gif": "image/gif",
        ".webp": "image/webp",
        ".bmp": "image/bmp",
        ".mp4": "video/mp4",
        ".mov": "video/quicktime",
        ".avi": "video/x-msvideo",
        ".webm": "video/webm",
        ".pdf": "application/pdf",
        ".doc": "application/msword",
        ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        ".xls": "application/vnd.ms-excel",
        ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        ".ppt": "application/vnd.ms-powerpoint",
        ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
        ".zip": "application/zip",
        ".txt": "text/plain",
      };
      contentType = mimeTypes[ext] || "application/octet-stream";
    } else {
      // HTTP URL
      log.info(`下载媒体文件 url=${mediaUrl.substring(0, 100)}`);
      const response = await fetch(mediaUrl);
      if (!response.ok) {
        log.error(`下载媒体文件失败 status=${response.status}`);
        return null;
      }
      contentType = response.headers.get("content-type") || "application/octet-stream";
      buffer = Buffer.from(await response.arrayBuffer());
      const urlPath = new URL(mediaUrl).pathname;
      fileName = urlPath.split("/").pop() || "media";
    }

    if (!fileName.includes(".")) {
      const ext = contentType.split("/")[1]?.split(";")[0] || "bin";
      fileName = `${fileName}.${ext}`;
    }

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
 * 发送媒体消息（自建应用）
 */
export async function sendWeComMedia(options: WeComSendMediaOptions): Promise<WeComSendResult> {
  const { credentials, agentId, toUser, mediaUrl, caption } = options;

  try {
    const mediaType = detectMediaType(mediaUrl);

    const uploadResult = await uploadMedia(credentials, mediaUrl, mediaType);
    if (!uploadResult) {
      log.info(`媒体上传失败，发送链接`);
      const text = caption ? `${caption}\n\n${mediaUrl}` : mediaUrl;
      return sendWeComMessage({
        credentials,
        agentId,
        toUser,
        content: text,
      });
    }

    const token = await getWeComAccessToken(credentials);
    const url = `https://qyapi.weixin.qq.com/cgi-bin/message/send?access_token=${token}`;

    const body: Record<string, unknown> = {
      touser: toUser,
      msgtype: mediaType,
      agentid: agentId,
      [mediaType]: {
        media_id: uploadResult.media_id,
      },
    };

    log.info(`发送媒体消息 type=${mediaType} to=${toUser}`);
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
      log.error(`发送媒体失败 errcode=${data.errcode} errmsg=${data.errmsg}`);
      return {
        success: false,
        errcode: data.errcode,
        errmsg: data.errmsg,
      };
    }

    if (caption) {
      await sendWeComMessage({
        credentials,
        agentId,
        toUser,
        content: caption,
      });
    }

    log.info(`媒体消息发送成功 type=${mediaType}`);
    return {
      success: true,
      msgid: data.msgid,
    };
  } catch (error) {
    log.error(`发送媒体消息异常: ${String(error)}`);
    return {
      success: false,
      errmsg: String(error),
    };
  }
}
