/**
 * 企业微信消息加解密
 *
 * 实现 WXBizMsgCrypt 算法
 */

import crypto from "crypto";

export class WeComCrypto {
  private token: string;
  private encodingAESKey: string;
  private corpId: string;
  private aesKey: Buffer;
  private iv: Buffer;

  constructor(token: string, encodingAESKey: string, corpId: string) {
    this.token = token;
    this.encodingAESKey = encodingAESKey;
    this.corpId = corpId;
    // AES 密钥 = Base64_Decode(EncodingAESKey + "=")
    this.aesKey = Buffer.from(encodingAESKey + "=", "base64");
    // IV 取 AES 密钥前 16 字节
    this.iv = this.aesKey.subarray(0, 16);
  }

  /**
   * 验证签名
   */
  verifySignature(signature: string, timestamp: string, nonce: string, echostr: string): boolean {
    const arr = [this.token, timestamp, nonce, echostr].sort();
    const sha1 = crypto.createHash("sha1").update(arr.join("")).digest("hex");
    return sha1 === signature;
  }

  /**
   * 生成签名
   */
  generateSignature(timestamp: string, nonce: string, encrypted: string): string {
    const arr = [this.token, timestamp, nonce, encrypted].sort();
    return crypto.createHash("sha1").update(arr.join("")).digest("hex");
  }

  /**
   * 解密消息
   */
  decrypt(encrypted: string): string {
    try {
      const decipher = crypto.createDecipheriv("aes-256-cbc", this.aesKey, this.iv);
      decipher.setAutoPadding(false);

      let decrypted = Buffer.concat([
        decipher.update(Buffer.from(encrypted, "base64")),
        decipher.final(),
      ]);

      // 去除 PKCS7 填充
      const pad = decrypted[decrypted.length - 1];
      decrypted = decrypted.subarray(0, decrypted.length - pad);

      // 消息格式: random(16B) + msgLen(4B) + msg + corpId
      // 跳过前 16 字节随机数
      const msgLen = decrypted.readUInt32BE(16);
      const msg = decrypted.subarray(20, 20 + msgLen).toString("utf8");

      return msg;
    } catch (error) {
      throw new Error(`解密失败: ${error}`);
    }
  }

  /**
   * 加密消息
   */
  encrypt(message: string): string {
    try {
      // 16 字节随机数
      const random = crypto.randomBytes(16);

      // 消息内容
      const msgBuffer = Buffer.from(message, "utf8");

      // 4 字节消息长度（网络字节序）
      const msgLenBuffer = Buffer.alloc(4);
      msgLenBuffer.writeUInt32BE(msgBuffer.length, 0);

      // 企业 ID
      const corpIdBuffer = Buffer.from(this.corpId, "utf8");

      // 拼接: random + msgLen + msg + corpId
      let content = Buffer.concat([random, msgLenBuffer, msgBuffer, corpIdBuffer]);

      // PKCS7 填充
      const blockSize = 32;
      const padLen = blockSize - (content.length % blockSize);
      const padBuffer = Buffer.alloc(padLen, padLen);
      content = Buffer.concat([content, padBuffer]);

      // AES 加密
      const cipher = crypto.createCipheriv("aes-256-cbc", this.aesKey, this.iv);
      cipher.setAutoPadding(false);

      const encrypted = Buffer.concat([cipher.update(content), cipher.final()]);

      return encrypted.toString("base64");
    } catch (error) {
      throw new Error(`加密失败: ${error}`);
    }
  }
}

/**
 * 解析 XML 消息
 */
export function parseWeComXml(xml: string): Record<string, string> {
  const result: Record<string, string> = {};

  const fields = [
    "ToUserName",
    "FromUserName",
    "CreateTime",
    "MsgType",
    "Content",
    "MsgId",
    "AgentID",
    "Encrypt",
    "Event",
    "EventKey",
    "PicUrl",
    "MediaId",
    "Format",
    "Recognition",
    "Latitude",
    "Longitude",
    "Scale",
    "Label",
  ];

  for (const field of fields) {
    // CDATA 格式
    const cdataRegex = new RegExp(`<${field}><!\\[CDATA\\[([\\s\\S]*?)\\]\\]></${field}>`, "i");
    const cdataMatch = xml.match(cdataRegex);
    if (cdataMatch) {
      result[field] = cdataMatch[1];
      continue;
    }

    // 普通格式
    const normalRegex = new RegExp(`<${field}>([\\s\\S]*?)</${field}>`, "i");
    const normalMatch = xml.match(normalRegex);
    if (normalMatch) {
      result[field] = normalMatch[1];
    }
  }

  return result;
}

/**
 * 生成 XML 响应
 */
export function buildWeComXml(data: Record<string, string | number>): string {
  let xml = "<xml>";
  for (const [key, value] of Object.entries(data)) {
    if (typeof value === "number") {
      xml += `<${key}>${value}</${key}>`;
    } else {
      xml += `<${key}><![CDATA[${value}]]></${key}>`;
    }
  }
  xml += "</xml>";
  return xml;
}
