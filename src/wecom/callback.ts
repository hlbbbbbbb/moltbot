/**
 * 企业微信回调服务器
 *
 * 接收企业微信的消息推送
 */

import http from "http";
import { URL } from "url";
import { EventEmitter } from "events";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { WeComCrypto, parseWeComXml } from "./crypto.js";

const log = createSubsystemLogger("gateway/channels/wecom").child("callback");

export interface WeComInboundMessage {
  id?: string;
  from: string;
  to: string;
  content: string;
  msgType: string;
  timestamp: Date;
  agentId?: string;
  mediaPath?: string;
  mediaType?: string;
  raw?: Record<string, string>;
}

export interface WeComCallbackServerOptions {
  port: number;
  path?: string;
  token: string;
  encodingAESKey: string;
  corpId: string;
}

export class WeComCallbackServer extends EventEmitter {
  private server: http.Server | null = null;
  private options: WeComCallbackServerOptions;
  private crypto: WeComCrypto;

  constructor(options: WeComCallbackServerOptions) {
    super();
    this.options = {
      path: "/wecom/callback",
      ...options,
    };
    this.crypto = new WeComCrypto(options.token, options.encodingAESKey, options.corpId);
  }

  /**
   * 启动服务器
   */
  async start(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.server = http.createServer((req, res) => {
        this.handleRequest(req, res);
      });

      this.server.on("error", (error) => {
        log.error(`服务器错误: ${String(error)}`);
        reject(error);
      });

      this.server.listen(this.options.port, () => {
        log.info(`回调服务器已启动 port=${this.options.port} path=${this.options.path}`);
        resolve();
      });
    });
  }

  /**
   * 停止服务器
   */
  async stop(): Promise<void> {
    return new Promise((resolve) => {
      if (this.server) {
        this.server.close(() => {
          log.info("回调服务器已停止");
          this.server = null;
          resolve();
        });
      } else {
        resolve();
      }
    });
  }

  /**
   * 获取服务器地址
   */
  getAddress(): string {
    return `http://localhost:${this.options.port}${this.options.path}`;
  }

  /**
   * 处理 HTTP 请求
   */
  private handleRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
    const url = new URL(req.url || "/", `http://localhost:${this.options.port}`);

    // 健康检查
    if (url.pathname === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "ok", service: "wecom-callback" }));
      return;
    }

    // 检查路径
    if (url.pathname !== this.options.path) {
      res.writeHead(404);
      res.end("Not Found");
      return;
    }

    const query = {
      msg_signature: url.searchParams.get("msg_signature") || "",
      timestamp: url.searchParams.get("timestamp") || "",
      nonce: url.searchParams.get("nonce") || "",
      echostr: url.searchParams.get("echostr") || "",
    };

    if (req.method === "GET") {
      this.handleVerify(query, res);
    } else if (req.method === "POST") {
      this.handleMessage(req, query, res);
    } else {
      res.writeHead(405);
      res.end("Method Not Allowed");
    }
  }

  /**
   * 处理 URL 验证
   */
  private handleVerify(
    query: { msg_signature: string; timestamp: string; nonce: string; echostr: string },
    res: http.ServerResponse,
  ): void {
    log.info("收到 URL 验证请求");

    if (!query.msg_signature || !query.timestamp || !query.nonce || !query.echostr) {
      log.error("URL 验证缺少参数");
      res.writeHead(400);
      res.end("Missing parameters");
      return;
    }

    if (
      !this.crypto.verifySignature(query.msg_signature, query.timestamp, query.nonce, query.echostr)
    ) {
      log.error("URL 验证签名失败");
      res.writeHead(403);
      res.end("Signature verification failed");
      return;
    }

    try {
      const decrypted = this.crypto.decrypt(query.echostr);
      log.info("URL 验证成功");
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end(decrypted);
    } catch (error) {
      log.error(`URL 验证解密失败: ${String(error)}`);
      res.writeHead(500);
      res.end("Decryption failed");
    }
  }

  /**
   * 处理消息回调
   */
  private handleMessage(
    req: http.IncomingMessage,
    query: { msg_signature: string; timestamp: string; nonce: string },
    res: http.ServerResponse,
  ): void {
    let body = "";

    req.on("data", (chunk) => {
      body += chunk;
    });

    req.on("end", () => {
      try {
        const xmlData = parseWeComXml(body);
        let msgData: Record<string, string>;

        // 检查是否是加密模式
        if (xmlData.Encrypt) {
          // 验证签名
          if (
            !this.crypto.verifySignature(
              query.msg_signature,
              query.timestamp,
              query.nonce,
              xmlData.Encrypt,
            )
          ) {
            log.error("消息签名验证失败");
            res.writeHead(200);
            res.end("success");
            return;
          }

          // 解密
          const decrypted = this.crypto.decrypt(xmlData.Encrypt);
          msgData = parseWeComXml(decrypted);
        } else {
          // 明文模式
          msgData = xmlData;
        }

        log.info(`收到消息 msgType=${msgData.MsgType} from=${msgData.FromUserName}`);

        // 构建消息对象
        const message: WeComInboundMessage = {
          id: msgData.MsgId,
          from: msgData.FromUserName,
          to: msgData.ToUserName,
          content: msgData.Content || "",
          msgType: msgData.MsgType,
          timestamp: new Date(parseInt(msgData.CreateTime || "0") * 1000),
          agentId: msgData.AgentID,
          raw: msgData,
        };

        // 触发消息事件
        this.emit("message", message);

        res.writeHead(200, { "Content-Type": "text/plain" });
        res.end("success");
      } catch (error) {
        log.error(`处理消息失败: ${String(error)}`);
        res.writeHead(200);
        res.end("success");
      }
    });

    req.on("error", (error) => {
      log.error(`请求读取错误: ${String(error)}`);
      res.writeHead(500);
      res.end("Internal Server Error");
    });
  }
}
