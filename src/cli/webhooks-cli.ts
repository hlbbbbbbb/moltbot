import type { Command } from "commander";

import { danger } from "../globals.js";
import {
  DEFAULT_GMAIL_LABEL,
  DEFAULT_GMAIL_MAX_BYTES,
  DEFAULT_GMAIL_RENEW_MINUTES,
  DEFAULT_GMAIL_SERVE_BIND,
  DEFAULT_GMAIL_SERVE_PATH,
  DEFAULT_GMAIL_SERVE_PORT,
  DEFAULT_GMAIL_SUBSCRIPTION,
  DEFAULT_GMAIL_TOPIC,
} from "../hooks/gmail.js";
import {
  type GmailRunOptions,
  type GmailSetupOptions,
  runGmailService,
  runGmailSetup,
} from "../hooks/gmail-ops.js";
import {
  DEFAULT_IMAP_BODY_MAX_BYTES,
  DEFAULT_IMAP_FOLDER,
  DEFAULT_IMAP_MAX_MESSAGES,
  DEFAULT_IMAP_PAGE_SIZE,
  runImapPoll,
  type ImapPollOptions,
} from "../hooks/imap-poller.js";
import { defaultRuntime } from "../runtime.js";
import { formatDocsLink } from "../terminal/links.js";
import { theme } from "../terminal/theme.js";

export function registerWebhooksCli(program: Command) {
  const webhooks = program
    .command("webhooks")
    .description("Webhook helpers and integrations")
    .addHelpText(
      "after",
      () =>
        `\n${theme.muted("Docs:")} ${formatDocsLink("/cli/webhooks", "docs.clawd.bot/cli/webhooks")}\n`,
    );

  const gmail = webhooks.command("gmail").description("Gmail Pub/Sub hooks (via gogcli)");

  gmail
    .command("setup")
    .description("Configure Gmail watch + Pub/Sub + Clawdbot hooks")
    .requiredOption("--account <email>", "Gmail account to watch")
    .option("--project <id>", "GCP project id (OAuth client owner)")
    .option("--topic <name>", "Pub/Sub topic name", DEFAULT_GMAIL_TOPIC)
    .option("--subscription <name>", "Pub/Sub subscription name", DEFAULT_GMAIL_SUBSCRIPTION)
    .option("--label <label>", "Gmail label to watch", DEFAULT_GMAIL_LABEL)
    .option("--hook-url <url>", "Clawdbot hook URL")
    .option("--hook-token <token>", "Clawdbot hook token")
    .option("--push-token <token>", "Push token for gog watch serve")
    .option("--bind <host>", "gog watch serve bind host", DEFAULT_GMAIL_SERVE_BIND)
    .option("--port <port>", "gog watch serve port", String(DEFAULT_GMAIL_SERVE_PORT))
    .option("--path <path>", "gog watch serve path", DEFAULT_GMAIL_SERVE_PATH)
    .option("--include-body", "Include email body snippets", true)
    .option("--max-bytes <n>", "Max bytes for body snippets", String(DEFAULT_GMAIL_MAX_BYTES))
    .option(
      "--renew-minutes <n>",
      "Renew watch every N minutes",
      String(DEFAULT_GMAIL_RENEW_MINUTES),
    )
    .option("--tailscale <mode>", "Expose push endpoint via tailscale (funnel|serve|off)", "funnel")
    .option("--tailscale-path <path>", "Path for tailscale serve/funnel")
    .option(
      "--tailscale-target <target>",
      "Tailscale serve/funnel target (port, host:port, or URL)",
    )
    .option("--push-endpoint <url>", "Explicit Pub/Sub push endpoint")
    .option("--json", "Output JSON summary", false)
    .action(async (opts) => {
      try {
        const parsed = parseGmailSetupOptions(opts);
        await runGmailSetup(parsed);
      } catch (err) {
        defaultRuntime.error(danger(String(err)));
        defaultRuntime.exit(1);
      }
    });

  gmail
    .command("run")
    .description("Run gog watch serve + auto-renew loop")
    .option("--account <email>", "Gmail account to watch")
    .option("--topic <topic>", "Pub/Sub topic path (projects/.../topics/..)")
    .option("--subscription <name>", "Pub/Sub subscription name")
    .option("--label <label>", "Gmail label to watch")
    .option("--hook-url <url>", "Clawdbot hook URL")
    .option("--hook-token <token>", "Clawdbot hook token")
    .option("--push-token <token>", "Push token for gog watch serve")
    .option("--bind <host>", "gog watch serve bind host")
    .option("--port <port>", "gog watch serve port")
    .option("--path <path>", "gog watch serve path")
    .option("--include-body", "Include email body snippets")
    .option("--max-bytes <n>", "Max bytes for body snippets")
    .option("--renew-minutes <n>", "Renew watch every N minutes")
    .option("--tailscale <mode>", "Expose push endpoint via tailscale (funnel|serve|off)")
    .option("--tailscale-path <path>", "Path for tailscale serve/funnel")
    .option(
      "--tailscale-target <target>",
      "Tailscale serve/funnel target (port, host:port, or URL)",
    )
    .action(async (opts) => {
      try {
        const parsed = parseGmailRunOptions(opts);
        await runGmailService(parsed);
      } catch (err) {
        defaultRuntime.error(danger(String(err)));
        defaultRuntime.exit(1);
      }
    });

  const imap = webhooks.command("imap").description("IMAP polling hooks (via himalaya)");

  imap
    .command("poll")
    .description("Poll IMAP once and forward only new emails to Clawdbot hooks")
    .requiredOption("--account <name>", "Himalaya account name")
    .option("--folder <name>", "IMAP folder to poll", DEFAULT_IMAP_FOLDER)
    .option(
      "--page-size <n>",
      "How many envelopes to scan each poll",
      String(DEFAULT_IMAP_PAGE_SIZE),
    )
    .option(
      "--max-messages <n>",
      "Max new messages forwarded per poll",
      String(DEFAULT_IMAP_MAX_MESSAGES),
    )
    .option("--state-file <path>", "Path to poller state file")
    .option("--hook-url <url>", "Clawdbot hook URL (default: /hooks/imap on local gateway)")
    .option("--hook-token <token>", "Clawdbot hook token (default: hooks.token)")
    .option("--source <name>", "Payload source field", "imap")
    .option("--himalaya-bin <path>", "Path to himalaya binary", "himalaya")
    .option("--timeout-ms <n>", "Command and webhook timeout in milliseconds")
    .option("--include-body", "Fetch each new message body and include it in payload")
    .option("--body-max-bytes <n>", "Body byte limit when --include-body is enabled")
    .option(
      "--bootstrap",
      "On first run, mark current mailbox contents as seen instead of forwarding history",
      true,
    )
    .option("--no-bootstrap", "Disable first-run bootstrap behavior")
    .option("--dry-run", "Print summary without sending webhook")
    .option("--json", "Output JSON summary")
    .action(async (opts) => {
      try {
        const parsed = parseImapPollOptions(opts);
        const result = await runImapPoll(parsed.poll);
        if (parsed.json) {
          defaultRuntime.log(JSON.stringify(result, null, 2));
          return;
        }
        const line = [
          `status=${result.status}`,
          `account=${result.account}`,
          `folder=${result.folder}`,
          `scanned=${result.scanned}`,
          `new=${result.newMessages}`,
          `delivered=${result.delivered}`,
        ].join(" ");
        defaultRuntime.log(line);
      } catch (err) {
        defaultRuntime.error(danger(String(err)));
        defaultRuntime.exit(1);
      }
    });
}

function parseGmailSetupOptions(raw: Record<string, unknown>): GmailSetupOptions {
  const accountRaw = raw.account;
  const account = typeof accountRaw === "string" ? accountRaw.trim() : "";
  if (!account) throw new Error("--account is required");
  return {
    account,
    project: stringOption(raw.project),
    topic: stringOption(raw.topic),
    subscription: stringOption(raw.subscription),
    label: stringOption(raw.label),
    hookUrl: stringOption(raw.hookUrl),
    hookToken: stringOption(raw.hookToken),
    pushToken: stringOption(raw.pushToken),
    bind: stringOption(raw.bind),
    port: numberOption(raw.port),
    path: stringOption(raw.path),
    includeBody: booleanOption(raw.includeBody),
    maxBytes: numberOption(raw.maxBytes),
    renewEveryMinutes: numberOption(raw.renewMinutes),
    tailscale: stringOption(raw.tailscale) as GmailSetupOptions["tailscale"],
    tailscalePath: stringOption(raw.tailscalePath),
    tailscaleTarget: stringOption(raw.tailscaleTarget),
    pushEndpoint: stringOption(raw.pushEndpoint),
    json: Boolean(raw.json),
  };
}

function parseGmailRunOptions(raw: Record<string, unknown>): GmailRunOptions {
  return {
    account: stringOption(raw.account),
    topic: stringOption(raw.topic),
    subscription: stringOption(raw.subscription),
    label: stringOption(raw.label),
    hookUrl: stringOption(raw.hookUrl),
    hookToken: stringOption(raw.hookToken),
    pushToken: stringOption(raw.pushToken),
    bind: stringOption(raw.bind),
    port: numberOption(raw.port),
    path: stringOption(raw.path),
    includeBody: booleanOption(raw.includeBody),
    maxBytes: numberOption(raw.maxBytes),
    renewEveryMinutes: numberOption(raw.renewMinutes),
    tailscale: stringOption(raw.tailscale) as GmailRunOptions["tailscale"],
    tailscalePath: stringOption(raw.tailscalePath),
    tailscaleTarget: stringOption(raw.tailscaleTarget),
  };
}

type ImapPollCliOptions = {
  poll: ImapPollOptions;
  json: boolean;
};

function parseImapPollOptions(raw: Record<string, unknown>): ImapPollCliOptions {
  const accountRaw = raw.account;
  const account = typeof accountRaw === "string" ? accountRaw.trim() : "";
  if (!account) throw new Error("--account is required");

  return {
    poll: {
      account,
      folder: stringOption(raw.folder),
      pageSize: numberOption(raw.pageSize),
      maxMessages: numberOption(raw.maxMessages),
      stateFile: stringOption(raw.stateFile),
      hookUrl: stringOption(raw.hookUrl),
      hookToken: stringOption(raw.hookToken),
      source: stringOption(raw.source),
      himalayaBin: stringOption(raw.himalayaBin),
      timeoutMs: numberOption(raw.timeoutMs),
      includeBody: booleanOption(raw.includeBody),
      bodyMaxBytes: numberOption(raw.bodyMaxBytes) ?? DEFAULT_IMAP_BODY_MAX_BYTES,
      dryRun: booleanOption(raw.dryRun),
      bootstrap: booleanOption(raw.bootstrap),
    },
    json: Boolean(raw.json),
  };
}

function stringOption(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

function numberOption(value: unknown): number | undefined {
  if (value === undefined || value === null) return undefined;
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n) || n <= 0) return undefined;
  return Math.floor(n);
}

function booleanOption(value: unknown): boolean | undefined {
  if (value === undefined || value === null) return undefined;
  return Boolean(value);
}
