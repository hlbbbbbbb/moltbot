/**
 * 企业微信配置 Schema
 */

import { z } from "zod";
import { GroupPolicySchema, ProviderCommandsSchema, RetryConfigSchema } from "./zod-schema.core.js";
import { ChannelHeartbeatVisibilitySchema } from "./zod-schema.channels.js";

export const WeComAccountSchemaBase = z
  .object({
    name: z.string().optional(),
    enabled: z.boolean().optional(),
    commands: ProviderCommandsSchema,

    // 企业微信凭证
    corpId: z.string().optional(),
    agentId: z.number().int().optional(),
    secret: z.string().optional(),

    // 回调配置
    token: z.string().optional(),
    encodingAESKey: z.string().optional(),
    callbackPort: z.number().int().optional(),
    callbackPath: z.string().optional(),

    // 访问控制
    allowFrom: z.array(z.string()).optional(),
    groupPolicy: GroupPolicySchema.optional().default("allowlist"),

    // 消息配置
    historyLimit: z.number().int().min(0).optional(),
    textChunkLimit: z.number().int().positive().optional(),

    // 重试
    retry: RetryConfigSchema,

    // 心跳
    heartbeat: ChannelHeartbeatVisibilitySchema,
  })
  .strict();

export const WeComAccountSchema = WeComAccountSchemaBase;

// 微信客服配置
export const WeComKfConfigSchema = z
  .object({
    enabled: z.boolean().optional(),
    openKfid: z.string().optional(),
    pollIntervalMs: z.number().int().positive().optional(),
  })
  .strict();

export const WeComConfigSchema = z
  .object({
    // 单账号配置（默认账号）
    name: z.string().optional(),
    enabled: z.boolean().optional(),
    commands: ProviderCommandsSchema,
    corpId: z.string().optional(),
    agentId: z.number().int().optional(),
    secret: z.string().optional(),
    token: z.string().optional(),
    encodingAESKey: z.string().optional(),
    callbackPort: z.number().int().optional(),
    callbackPath: z.string().optional(),
    allowFrom: z.array(z.string()).optional(),
    groupPolicy: GroupPolicySchema.optional(),
    historyLimit: z.number().int().min(0).optional(),
    textChunkLimit: z.number().int().positive().optional(),
    retry: RetryConfigSchema,
    heartbeat: ChannelHeartbeatVisibilitySchema,

    // 微信客服配置
    kf: WeComKfConfigSchema.optional(),

    // 多账号配置
    accounts: z.record(z.string(), WeComAccountSchema.optional()).optional(),
  })
  .strict();
