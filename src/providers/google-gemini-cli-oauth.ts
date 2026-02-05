import type { OAuthCredentials } from "@mariozechner/pi-ai";
import { ProxyAgent } from "undici";
import { formatCliCommand } from "../cli/command-format.js";

const TOKEN_URL = "https://oauth2.googleapis.com/token";

// 从 Gemini CLI 安装包中提取 credentials 的逻辑
import { existsSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { delimiter, dirname, join } from "node:path";

// 获取代理配置
function getProxyAgent(): ProxyAgent | undefined {
  const proxyUrl =
    process.env.HTTPS_PROXY ||
    process.env.https_proxy ||
    process.env.HTTP_PROXY ||
    process.env.http_proxy;
  if (proxyUrl) {
    return new ProxyAgent(proxyUrl);
  }
  return undefined;
}

let cachedCredentials: { clientId: string; clientSecret: string } | null = null;

function findInPath(name: string): string | null {
  const exts = process.platform === "win32" ? [".cmd", ".bat", ".exe", ""] : [""];
  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    for (const ext of exts) {
      const p = join(dir, name + ext);
      if (existsSync(p)) return p;
    }
  }
  return null;
}

function findFile(dir: string, name: string, depth: number): string | null {
  if (depth <= 0) return null;
  try {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isFile() && e.name === name) return p;
      if (e.isDirectory() && !e.name.startsWith(".")) {
        const found = findFile(p, name, depth - 1);
        if (found) return found;
      }
    }
  } catch {}
  return null;
}

function extractGeminiCliCredentials(): { clientId: string; clientSecret: string } | null {
  if (cachedCredentials) return cachedCredentials;

  try {
    const geminiPath = findInPath("gemini");
    if (!geminiPath) return null;

    const resolvedPath = realpathSync(geminiPath);
    const geminiCliDir = dirname(dirname(resolvedPath));

    const searchPaths = [
      join(
        geminiCliDir,
        "node_modules",
        "@google",
        "gemini-cli-core",
        "dist",
        "src",
        "code_assist",
        "oauth2.js",
      ),
      join(
        geminiCliDir,
        "node_modules",
        "@google",
        "gemini-cli-core",
        "dist",
        "code_assist",
        "oauth2.js",
      ),
    ];

    let content: string | null = null;
    for (const p of searchPaths) {
      if (existsSync(p)) {
        content = readFileSync(p, "utf8");
        break;
      }
    }
    if (!content) {
      const found = findFile(geminiCliDir, "oauth2.js", 10);
      if (found) content = readFileSync(found, "utf8");
    }
    if (!content) return null;

    const idMatch = content.match(/(\d+-[a-z0-9]+\.apps\.googleusercontent\.com)/);
    const secretMatch = content.match(/(GOCSPX-[A-Za-z0-9_-]+)/);
    if (idMatch && secretMatch) {
      cachedCredentials = { clientId: idMatch[1], clientSecret: secretMatch[1] };
      return cachedCredentials;
    }
  } catch {
    // Gemini CLI not installed or extraction failed
  }
  return null;
}

function resolveOAuthClientConfig(): { clientId: string; clientSecret?: string } {
  // 1. Check env vars first (user override)
  const envClientId =
    process.env.CLAWDBOT_GEMINI_OAUTH_CLIENT_ID?.trim() ||
    process.env.GEMINI_CLI_OAUTH_CLIENT_ID?.trim();
  const envClientSecret =
    process.env.CLAWDBOT_GEMINI_OAUTH_CLIENT_SECRET?.trim() ||
    process.env.GEMINI_CLI_OAUTH_CLIENT_SECRET?.trim();
  if (envClientId) {
    return { clientId: envClientId, clientSecret: envClientSecret };
  }

  // 2. Try to extract from installed Gemini CLI
  const extracted = extractGeminiCliCredentials();
  if (extracted) {
    return extracted;
  }

  // 3. No credentials available
  throw new Error("Gemini CLI not found. Install it first or set GEMINI_CLI_OAUTH_CLIENT_ID.");
}

export async function refreshGoogleGeminiCliCredentials(
  credentials: OAuthCredentials,
): Promise<OAuthCredentials> {
  if (!credentials.refresh?.trim()) {
    throw new Error(
      `Google Gemini CLI OAuth refresh token missing. Re-authenticate with \`${formatCliCommand("clawdbot models auth login --provider google-gemini-cli")}\`.`,
    );
  }

  const { clientId, clientSecret } = resolveOAuthClientConfig();

  const body = new URLSearchParams({
    client_id: clientId,
    grant_type: "refresh_token",
    refresh_token: credentials.refresh,
  });
  if (clientSecret) {
    body.set("client_secret", clientSecret);
  }

  const dispatcher = getProxyAgent();
  const response = await fetch(TOKEN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body,
    // @ts-expect-error undici dispatcher for proxy support
    dispatcher,
  });

  if (!response.ok) {
    const text = await response.text();
    if (response.status === 400 || response.status === 401) {
      throw new Error(
        `Google Gemini CLI OAuth refresh token expired or invalid. Re-authenticate with \`${formatCliCommand("clawdbot models auth login --provider google-gemini-cli")}\`.`,
      );
    }
    throw new Error(`Google Gemini CLI OAuth refresh failed: ${text || response.statusText}`);
  }

  const payload = (await response.json()) as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
  };

  if (!payload.access_token) {
    throw new Error("Google Gemini CLI OAuth refresh response missing access token.");
  }

  // Google OAuth refresh 通常不返回新的 refresh_token，保留原来的
  const expiresIn = payload.expires_in ?? 3600; // 默认 1 小时

  return {
    ...credentials,
    access: payload.access_token,
    refresh: payload.refresh_token || credentials.refresh,
    expires: Date.now() + expiresIn * 1000 - 5 * 60 * 1000, // 提前 5 分钟过期
  };
}
