/**
 * 企业微信类型定义
 */

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

export interface WeComSendResult {
  success: boolean;
  errcode?: number;
  errmsg?: string;
  msgid?: string;
}

export interface WeComMonitorResult {
  close: () => Promise<void>;
}
