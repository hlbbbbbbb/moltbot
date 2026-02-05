/**
 * 微信客服发送消息
 */

import fs from "node:fs";
import path from "node:path";

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

    // 分割长消息（使用默认的安全上限 1800）
    const chunks = splitMessage(content);

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
 *
 * 微信客服消息限制：
 * - 文本消息最大 2048 字符
 * - 为安全起见使用 1800 作为上限（留余量给 emoji 等多字节字符）
 */
function splitMessage(message: string, maxLength: number = 1800): string[] {
  if (!message || message.length <= maxLength) {
    return message ? [message] : [];
  }

  const chunks: string[] = [];
  let remaining = message;

  while (remaining.length > 0) {
    if (remaining.length <= maxLength) {
      chunks.push(remaining);
      break;
    }

    // 优先在换行处分割
    let splitIndex = remaining.lastIndexOf("\n", maxLength);

    // 如果找不到合适的换行，尝试在句号、问号、感叹号处分割
    if (splitIndex === -1 || splitIndex < maxLength * 0.3) {
      const punctuations = ["。", "！", "？", ".", "!", "?", "；", ";"];
      for (const p of punctuations) {
        const idx = remaining.lastIndexOf(p, maxLength);
        if (idx > splitIndex && idx >= maxLength * 0.3) {
          splitIndex = idx + 1; // 包含标点
          break;
        }
      }
    }

    // 如果还是找不到，尝试在空格处分割
    if (splitIndex === -1 || splitIndex < maxLength * 0.3) {
      splitIndex = remaining.lastIndexOf(" ", maxLength);
    }

    // 最后手段：强制截断
    if (splitIndex === -1 || splitIndex < maxLength * 0.3) {
      splitIndex = maxLength;
    }

    chunks.push(remaining.substring(0, splitIndex).trim());
    remaining = remaining.substring(splitIndex).trim();
  }

  // 如果分成了多条，添加分页提示（不使用emoji，避免兼容性问题）
  if (chunks.length > 1) {
    return chunks.map((chunk, i) => {
      const pageInfo = `(${i + 1}/${chunks.length})`;
      // 第一条在末尾加提示，后续条在开头加提示
      if (i === 0) {
        return `${chunk}\n\n${pageInfo} ...`;
      } else if (i === chunks.length - 1) {
        return `${pageInfo}\n${chunk}`;
      } else {
        return `${pageInfo}\n${chunk}\n\n...`;
      }
    });
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
