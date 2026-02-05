import { execSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// Cursor API configuration
const CURSOR_API_BASE = "https://api2.cursor.sh";

// Supported model list
const DEFAULT_MODELS = [
  "claude-4.5-sonnet",
  "claude-4.5-opus",
  "gpt-5.2",
  "gpt-5.2-codex",
  "gemini-3-pro",
  "gemini-3-flash",
  "grok-code",
  "composer-1",
] as const;

export type CursorCliOAuthCredentials = {
  access: string;
  refresh?: string;
  expires?: number;
  email?: string;
  userId?: string;
};

export type CursorCliOAuthContext = {
  isRemote: boolean;
  openUrl: (url: string) => Promise<void>;
  log: (msg: string) => void;
  note: (message: string, title?: string) => Promise<void>;
  prompt: (message: string) => Promise<string>;
  progress: { update: (msg: string) => void; stop: (msg?: string) => void };
};

/**
 * Read Cursor access token from macOS Keychain
 */
function readKeychainToken(service: string, account: string): string | null {
  if (process.platform !== "darwin") {
    return null;
  }
  
  try {
    const result = execSync(
      `security find-generic-password -s "${service}" -a "${account}" -w 2>/dev/null`,
      { encoding: "utf8", timeout: 5000 }
    );
    return result.trim() || null;
  } catch {
    return null;
  }
}

/**
 * Read Cursor auth info from cli-config.json
 */
function readCursorAuthInfo(): { email?: string; userId?: number; authId?: string } | null {
  try {
    const configPath = join(homedir(), ".cursor", "cli-config.json");
    if (!existsSync(configPath)) {
      return null;
    }
    
    const content = readFileSync(configPath, "utf8");
    const config = JSON.parse(content) as {
      authInfo?: {
        email?: string;
        userId?: number;
        authId?: string;
      };
    };
    
    return config.authInfo ?? null;
  } catch {
    return null;
  }
}

/**
 * Parse JWT token to get expiration time
 */
function parseJwtExpiration(token: string): number | undefined {
  try {
    const parts = token.split(".");
    if (parts.length !== 3) return undefined;
    
    const payload = JSON.parse(Buffer.from(parts[1], "base64").toString("utf8")) as {
      exp?: number;
    };
    
    if (typeof payload.exp === "number") {
      // Convert to milliseconds
      return payload.exp * 1000;
    }
  } catch {
    // Invalid JWT
  }
  return undefined;
}

/**
 * Try to use token from environment variables
 */
function tryEnvToken(): CursorCliOAuthCredentials | null {
  const accessToken = process.env.CURSOR_ACCESS_TOKEN?.trim();
  if (!accessToken) return null;

  return {
    access: accessToken,
    refresh: process.env.CURSOR_REFRESH_TOKEN?.trim(),
    expires: parseJwtExpiration(accessToken),
  };
}

/**
 * Try to read existing Cursor credentials from macOS Keychain
 */
function tryKeychainCredentials(): CursorCliOAuthCredentials | null {
  const accessToken = readKeychainToken("cursor-access-token", "cursor-user");
  if (!accessToken) {
    return null;
  }
  
  const refreshToken = readKeychainToken("cursor-refresh-token", "cursor-user");
  const authInfo = readCursorAuthInfo();
  const expires = parseJwtExpiration(accessToken);
  
  return {
    access: accessToken,
    refresh: refreshToken ?? undefined,
    expires,
    email: authInfo?.email,
    userId: authInfo?.userId?.toString(),
  };
}

/**
 * Check if Cursor CLI is logged in by running 'cursor agent status'
 */
async function checkCursorLoginStatus(): Promise<boolean> {
  try {
    // Try common Cursor CLI paths
    const paths = [
      "/Applications/Cursor.app/Contents/Resources/app/bin/cursor",
      join(homedir(), "Applications/Cursor.app/Contents/Resources/app/bin/cursor"),
      "cursor", // In case it's in PATH
    ];
    
    for (const cursorPath of paths) {
      try {
        const result = execSync(`"${cursorPath}" agent status 2>&1`, {
          encoding: "utf8",
          timeout: 10000,
        });
        
        if (result.includes("Logged in as")) {
          return true;
        }
      } catch {
        continue;
      }
    }
  } catch {
    // Cursor CLI not available
  }
  return false;
}

/**
 * Prompt user to login via Cursor CLI
 */
async function promptCursorLogin(ctx: CursorCliOAuthContext): Promise<void> {
  const cursorPath = "/Applications/Cursor.app/Contents/Resources/app/bin/cursor";
  
  await ctx.note(
    [
      "Cursor credentials not found in Keychain.",
      "",
      "Please run the following command to login:",
      `  ${cursorPath} agent login`,
      "",
      "Or open Cursor IDE and sign in there.",
      "Then try this authentication again.",
    ].join("\n"),
    "Cursor Login Required",
  );
}

/**
 * Main login flow - reads existing Cursor credentials
 */
export async function loginCursorCliOAuth(
  ctx: CursorCliOAuthContext,
): Promise<CursorCliOAuthCredentials> {
  // 1. First check environment variables
  ctx.progress.update("Checking environment variables...");
  const envToken = tryEnvToken();
  if (envToken) {
    ctx.progress.stop("Using CURSOR_ACCESS_TOKEN from environment");
    return envToken;
  }

  // 2. Try to read from macOS Keychain (where Cursor stores its tokens)
  ctx.progress.update("Reading Cursor credentials from Keychain...");
  const keychainCreds = tryKeychainCredentials();
  
  if (keychainCreds) {
    // Check if token is expired
    if (keychainCreds.expires && Date.now() >= keychainCreds.expires) {
      ctx.progress.update("Cursor token expired, please re-login in Cursor IDE");
      await promptCursorLogin(ctx);
      throw new Error("Cursor token expired. Please login again via Cursor IDE or CLI.");
    }
    
    ctx.progress.stop("Cursor CLI credentials loaded from Keychain");
    return keychainCreds;
  }

  // 3. Credentials not found - prompt user to login
  ctx.progress.stop("Cursor credentials not found");
  
  // Check if Cursor is logged in via CLI
  const isLoggedIn = await checkCursorLoginStatus();
  if (isLoggedIn) {
    // User is logged in but we couldn't read the token - might be a permission issue
    await ctx.note(
      [
        "Cursor reports you are logged in, but we couldn't read the access token.",
        "This might be a Keychain permission issue.",
        "",
        "Try running Cursor agent login again:",
        "  /Applications/Cursor.app/Contents/Resources/app/bin/cursor agent login",
      ].join("\n"),
      "Permission Issue",
    );
    throw new Error("Could not read Cursor credentials from Keychain.");
  }
  
  await promptCursorLogin(ctx);
  throw new Error(
    "Cursor not logged in. Please run 'cursor agent login' or sign in via Cursor IDE first.",
  );
}

/**
 * Refresh token - Cursor handles this internally, so we just re-read from Keychain
 */
export async function refreshCursorCliCredentials(
  credentials: CursorCliOAuthCredentials,
): Promise<CursorCliOAuthCredentials> {
  // Try to get fresh credentials from Keychain
  const keychainCreds = tryKeychainCredentials();
  
  if (keychainCreds && keychainCreds.access !== credentials.access) {
    // Cursor refreshed the token
    return keychainCreds;
  }
  
  // Return existing credentials if still valid
  if (credentials.expires && Date.now() < credentials.expires) {
    return credentials;
  }
  
  throw new Error(
    "Cursor token expired. Please re-login via Cursor IDE or run 'cursor agent login'.",
  );
}

export { DEFAULT_MODELS };
