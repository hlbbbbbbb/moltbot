/**
 * WeCom/企业微信 集成
 *
 * 支持企业微信自建应用和微信客服的消息收发
 */

// 自建应用
export { monitorWeComChannel } from "./monitor.js";
export { probeWeCom } from "./probe.js";
export { sendWeComMessage } from "./send.js";
export { resolveWeComAccount, type WeComAccount } from "./accounts.js";
export { getWeComAccessToken, type WeComCredentials } from "./token.js";
export { WeComCallbackServer } from "./callback.js";
export { WeComCrypto } from "./crypto.js";

// 微信客服
export { monitorWeComKfChannel, monitorWeComKfWithCallback } from "./kf-monitor.js";
export { sendWeComKfMessage, sendWeComKfMedia } from "./kf-send.js";
export { syncKfMessages, getKfAccountList } from "./kf-sync.js";
