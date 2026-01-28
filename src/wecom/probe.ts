/**
 * 企业微信服务探测
 */

import { getWeComAccessToken, type WeComCredentials } from "./token.js";

export interface WeComProbeResult {
  ok: boolean;
  error?: string;
  corpId?: string;
}

/**
 * 探测企业微信服务是否可用
 */
export async function probeWeCom(credentials: WeComCredentials): Promise<WeComProbeResult> {
  try {
    await getWeComAccessToken(credentials);
    return {
      ok: true,
      corpId: credentials.corpId,
    };
  } catch (error) {
    return {
      ok: false,
      error: String(error),
      corpId: credentials.corpId,
    };
  }
}
