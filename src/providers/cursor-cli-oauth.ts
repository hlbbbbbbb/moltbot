import type { OAuthCredentials } from "@mariozechner/pi-ai";
import { execSync } from "node:child_process";
import { formatCliCommand } from "../cli/command-format.js";

/**
 * Read Cursor token from macOS Keychain
 */
function readKeychainToken(service: string, account: string): string | null {
  if (process.platform !== "darwin") {
    return null;
  }

  try {
    const result = execSync(
      `security find-generic-password -s "${service}" -a "${account}" -w 2>/dev/null`,
      { encoding: "utf8", timeout: 5000 },
    );
    return result.trim() || null;
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
      return payload.exp * 1000; // Convert to milliseconds
    }
  } catch {
    // Invalid JWT
  }
  return undefined;
}

export async function refreshCursorCliCredentials(
  credentials: OAuthCredentials,
): Promise<OAuthCredentials> {
  // Cursor stores and refreshes tokens internally via its own mechanisms
  // We just need to re-read from Keychain to get the latest tokens

  const accessToken = readKeychainToken("cursor-access-token", "cursor-user");

  if (accessToken && accessToken !== credentials.access) {
    // Cursor has refreshed the token
    const refreshToken = readKeychainToken("cursor-refresh-token", "cursor-user");
    const expires = parseJwtExpiration(accessToken);

    return {
      ...credentials,
      access: accessToken,
      refresh: refreshToken ?? credentials.refresh,
      expires: expires ?? credentials.expires,
    };
  }

  // Check if current token is still valid
  if (credentials.expires && Date.now() < credentials.expires) {
    return credentials;
  }

  // Token expired and Cursor hasn't refreshed it
  throw new Error(
    `Cursor CLI OAuth token expired. Re-authenticate via Cursor IDE or run \`${formatCliCommand("/Applications/Cursor.app/Contents/Resources/app/bin/cursor agent login")}\`.`,
  );
}
