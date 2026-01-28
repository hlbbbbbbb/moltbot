/**
 * 微信客服消息同步
 *
 * 用于拉取客服消息
 */

import { createSubsystemLogger } from "../logging/subsystem.js";
import { getWeComAccessToken, type WeComCredentials } from "./token.js";

const log = createSubsystemLogger("gateway/channels/wecom").child("kf-sync");

export interface KfMessage {
  msgid: string;
  open_kfid: string;
  external_userid: string;
  send_time: number;
  origin: number; // 3=客户发送 4=系统 5=接待人员发送
  servicer_userid?: string;
  msgtype: string;
  text?: { content: string };
  image?: { media_id: string };
  voice?: { media_id: string };
  video?: { media_id: string };
  file?: { media_id: string };
  location?: { latitude: number; longitude: number; name: string; address: string };
  link?: { title: string; desc: string; url: string; pic_url: string };
  business_card?: { userid: string };
  miniprogram?: { title: string; appid: string; pagepath: string; thumb_media_id: string };
  event?: {
    event_type: string;
    open_kfid?: string;
    external_userid?: string;
    scene?: string;
    scene_param?: string;
    welcome_code?: string;
    fail_msgid?: string;
    fail_type?: number;
    servicer_userid?: string;
    status?: number;
    change_type?: number;
    old_servicer_userid?: string;
    new_servicer_userid?: string;
    msg_code?: string;
  };
}

export interface KfSyncResult {
  errcode: number;
  errmsg: string;
  next_cursor?: string;
  has_more?: number;
  msg_list?: KfMessage[];
}

export interface KfSyncOptions {
  credentials: WeComCredentials;
  cursor?: string;
  token?: string;
  limit?: number;
  voice_format?: number;
  open_kfid?: string;
}

/**
 * 同步客服消息
 */
export async function syncKfMessages(options: KfSyncOptions): Promise<KfSyncResult> {
  const { credentials, cursor, token: syncToken, limit = 1000, voice_format, open_kfid } = options;

  try {
    const accessToken = await getWeComAccessToken(credentials);
    const url = `https://qyapi.weixin.qq.com/cgi-bin/kf/sync_msg?access_token=${accessToken}`;

    const body: Record<string, unknown> = {
      limit,
    };

    if (cursor) body.cursor = cursor;
    if (syncToken) body.token = syncToken;
    if (voice_format) body.voice_format = voice_format;
    if (open_kfid) body.open_kfid = open_kfid;

    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    const data = (await response.json()) as KfSyncResult;

    if (data.errcode !== 0) {
      log.error(`同步客服消息失败 errcode=${data.errcode} errmsg=${data.errmsg}`);
    } else {
      log.info(`同步客服消息成功 count=${data.msg_list?.length || 0} has_more=${data.has_more}`);
    }

    return data;
  } catch (error) {
    log.error(`同步客服消息异常: ${String(error)}`);
    return {
      errcode: -1,
      errmsg: String(error),
    };
  }
}

/**
 * 获取客服账号列表
 */
export async function getKfAccountList(credentials: WeComCredentials): Promise<{
  errcode: number;
  errmsg: string;
  account_list?: Array<{
    open_kfid: string;
    name: string;
    avatar: string;
    manage_privilege: boolean;
  }>;
}> {
  try {
    const accessToken = await getWeComAccessToken(credentials);
    const url = `https://qyapi.weixin.qq.com/cgi-bin/kf/account/list?access_token=${accessToken}`;

    const response = await fetch(url);
    const data = await response.json();

    return data as {
      errcode: number;
      errmsg: string;
      account_list?: Array<{
        open_kfid: string;
        name: string;
        avatar: string;
        manage_privilege: boolean;
      }>;
    };
  } catch (error) {
    log.error(`获取客服账号列表失败: ${String(error)}`);
    return {
      errcode: -1,
      errmsg: String(error),
    };
  }
}
