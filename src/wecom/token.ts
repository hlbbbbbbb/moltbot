/**
 * 企业微信 Access Token 管理
 */

import { createSubsystemLogger } from "../logging/subsystem.js";

const log = createSubsystemLogger("gateway/channels/wecom").child("token");

export interface WeComCredentials {
  corpId: string;
  secret: string;
}

interface TokenCache {
  token: string;
  expiresAt: number;
}

// Token 缓存
const tokenCache = new Map<string, TokenCache>();

/**
 * 获取 Access Token
 */
export async function getWeComAccessToken(credentials: WeComCredentials): Promise<string> {
  const cacheKey = `${credentials.corpId}:${credentials.secret.substring(0, 8)}`;

  // 检查缓存
  const cached = tokenCache.get(cacheKey);
  if (cached && Date.now() < cached.expiresAt) {
    return cached.token;
  }

  // 请求新 Token
  const url = `https://qyapi.weixin.qq.com/cgi-bin/gettoken?corpid=${credentials.corpId}&corpsecret=${credentials.secret}`;

  try {
    const response = await fetch(url);
    const data = (await response.json()) as {
      errcode?: number;
      errmsg?: string;
      access_token?: string;
      expires_in?: number;
    };

    if (data.errcode && data.errcode !== 0) {
      throw new Error(`企业微信 API 错误: ${data.errmsg} (${data.errcode})`);
    }

    if (!data.access_token) {
      throw new Error("未获取到 access_token");
    }

    // 缓存，提前 5 分钟过期
    const expiresIn = (data.expires_in || 7200) - 300;
    tokenCache.set(cacheKey, {
      token: data.access_token,
      expiresAt: Date.now() + expiresIn * 1000,
    });

    log.info("Access Token 获取成功");
    return data.access_token;
  } catch (error) {
    log.error(`获取 Access Token 失败: ${String(error)}`);
    throw error;
  }
}

/**
 * 清除 Token 缓存
 */
export function clearWeComTokenCache(credentials?: WeComCredentials): void {
  if (credentials) {
    const cacheKey = `${credentials.corpId}:${credentials.secret.substring(0, 8)}`;
    tokenCache.delete(cacheKey);
  } else {
    tokenCache.clear();
  }
}
