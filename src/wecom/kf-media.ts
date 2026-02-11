/**
 * 微信客服媒体处理
 */

import { createSubsystemLogger } from "../logging/subsystem.js";
import { getWeComAccessToken, type WeComCredentials } from "./token.js";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

const log = createSubsystemLogger("gateway/channels/wecom").child("kf-media");

/**
 * 获取临时素材的 URL
 *
 * 企业微信临时素材有效期为 3 天
 */
export async function getMediaUrl(
  credentials: WeComCredentials,
  mediaId: string,
): Promise<string | null> {
  try {
    const token = await getWeComAccessToken(credentials);
    // 这个 URL 可以直接访问获取媒体内容
    const url = `https://qyapi.weixin.qq.com/cgi-bin/media/get?access_token=${token}&media_id=${mediaId}`;
    return url;
  } catch (error) {
    log.error(`获取媒体 URL 失败: ${String(error)}`);
    return null;
  }
}

/**
 * 下载媒体文件到临时目录
 */
export async function downloadMedia(
  credentials: WeComCredentials,
  mediaId: string,
  _mediaType: string = "image",
): Promise<{ path: string; url: string; contentType: string } | null> {
  try {
    const token = await getWeComAccessToken(credentials);
    const url = `https://qyapi.weixin.qq.com/cgi-bin/media/get?access_token=${token}&media_id=${mediaId}`;

    log.info(`下载媒体 mediaId=${mediaId.substring(0, 20)}...`);
    const response = await fetch(url);

    if (!response.ok) {
      log.error(`下载媒体失败 status=${response.status}`);
      return null;
    }

    const contentType = response.headers.get("content-type") || "application/octet-stream";

    // 检查是否是错误响应（JSON）
    if (contentType.includes("application/json")) {
      const data = (await response.json()) as { errcode?: number; errmsg?: string };
      if (data.errcode) {
        log.error(`下载媒体失败 errcode=${data.errcode} errmsg=${data.errmsg}`);
        return null;
      }
    }

    const buffer = Buffer.from(await response.arrayBuffer());

    // 确定文件扩展名
    let ext = "bin";
    if (contentType.includes("image/jpeg") || contentType.includes("image/jpg")) ext = "jpg";
    else if (contentType.includes("image/png")) ext = "png";
    else if (contentType.includes("image/gif")) ext = "gif";
    else if (contentType.includes("image/webp")) ext = "webp";
    else if (contentType.includes("video/mp4")) ext = "mp4";
    else if (contentType.includes("audio/")) ext = "mp3";

    // 保存到临时目录
    const tmpDir = path.join(os.tmpdir(), "clawdbot", "wecom-media");
    await fs.promises.mkdir(tmpDir, { recursive: true });

    const fileName = `${mediaId.substring(0, 16)}_${Date.now()}.${ext}`;
    const filePath = path.join(tmpDir, fileName);

    await fs.promises.writeFile(filePath, buffer);

    log.info(`媒体已下载 path=${filePath} size=${buffer.length}`);

    return {
      path: filePath,
      url: filePath, // 本地路径作为 URL
      contentType,
    };
  } catch (error) {
    log.error(`下载媒体异常: ${String(error)}`);
    return null;
  }
}

/**
 * 获取高清语音素材
 */
export async function getVoiceMedia(
  credentials: WeComCredentials,
  mediaId: string,
): Promise<{ path: string; url: string; contentType: string } | null> {
  try {
    const token = await getWeComAccessToken(credentials);
    const url = `https://qyapi.weixin.qq.com/cgi-bin/media/get/jssdk?access_token=${token}&media_id=${mediaId}`;

    log.info(`下载语音 mediaId=${mediaId.substring(0, 20)}...`);
    const response = await fetch(url);

    if (!response.ok) {
      log.error(`下载语音失败 status=${response.status}`);
      return null;
    }

    const contentType = response.headers.get("content-type") || "audio/amr";
    const buffer = Buffer.from(await response.arrayBuffer());

    const tmpDir = path.join(os.tmpdir(), "clawdbot", "wecom-media");
    await fs.promises.mkdir(tmpDir, { recursive: true });

    const fileName = `voice_${mediaId.substring(0, 16)}_${Date.now()}.amr`;
    const filePath = path.join(tmpDir, fileName);

    await fs.promises.writeFile(filePath, buffer);

    log.info(`语音已下载 path=${filePath} size=${buffer.length}`);

    return {
      path: filePath,
      url: filePath,
      contentType,
    };
  } catch (error) {
    log.error(`下载语音异常: ${String(error)}`);
    return null;
  }
}
