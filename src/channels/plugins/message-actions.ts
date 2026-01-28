import type { AgentToolResult } from "@mariozechner/pi-agent-core";

import type { ClawdbotConfig } from "../../config/config.js";
import { getChannelPlugin, listChannelPlugins } from "./index.js";
import type { ChannelMessageActionContext, ChannelMessageActionName } from "./types.js";
import { wecomMessageActions } from "./actions/wecom.js";

export function listChannelMessageActions(cfg: ClawdbotConfig): ChannelMessageActionName[] {
  const actions = new Set<ChannelMessageActionName>(["send", "broadcast"]);
  for (const plugin of listChannelPlugins()) {
    const list = plugin.actions?.listActions?.({ cfg });
    if (!list) continue;
    for (const action of list) actions.add(action);
  }
  // Add WeCom actions if configured
  const wecomActions = wecomMessageActions.listActions?.({ cfg });
  if (wecomActions) {
    for (const action of wecomActions) actions.add(action);
  }
  return Array.from(actions);
}

export function supportsChannelMessageButtons(cfg: ClawdbotConfig): boolean {
  for (const plugin of listChannelPlugins()) {
    if (plugin.actions?.supportsButtons?.({ cfg })) return true;
  }
  return false;
}

export function supportsChannelMessageCards(cfg: ClawdbotConfig): boolean {
  for (const plugin of listChannelPlugins()) {
    if (plugin.actions?.supportsCards?.({ cfg })) return true;
  }
  return false;
}

export async function dispatchChannelMessageAction(
  ctx: ChannelMessageActionContext,
): Promise<AgentToolResult<unknown> | null> {
  // Handle WeCom channel directly (not registered as a full plugin)
  if (ctx.channel === "wecom" || ctx.channel === "wecom-kf") {
    const actions = wecomMessageActions.listActions?.({ cfg: ctx.cfg }) ?? [];
    if (actions.includes(ctx.action as ChannelMessageActionName)) {
      return await wecomMessageActions.handleAction!(ctx);
    }
    return null;
  }

  const plugin = getChannelPlugin(ctx.channel);
  if (!plugin?.actions?.handleAction) return null;
  if (plugin.actions.supportsAction && !plugin.actions.supportsAction({ action: ctx.action })) {
    return null;
  }
  return await plugin.actions.handleAction(ctx);
}
