# Cursor CLI Auth Plugin

This plugin provides OAuth authentication flow for Cursor CLI, enabling access to Cursor's AI models through your Cursor subscription.

## Features

- OAuth 2.0 device flow authentication
- Automatic token refresh
- Support for Cursor's multi-model access (Claude, GPT, Gemini, etc.)

## Usage

During onboarding, select "Cursor CLI OAuth" as your authentication method. The plugin will:

1. Generate a device code
2. Open a browser for authentication
3. Poll for the access token
4. Store credentials securely

## Environment Variables

- `CURSOR_ACCESS_TOKEN`: Pre-configured access token (optional, bypasses OAuth)
- `CURSOR_REFRESH_TOKEN`: Pre-configured refresh token (optional)

## Supported Models

Through Cursor CLI authentication, you can access:

- Claude 4.5 Sonnet / Opus
- GPT-5.2 / GPT-5.2 Codex
- Gemini 3 Pro / Flash
- Grok Code
- And more models available in your Cursor subscription

## Notes

- Requires an active Cursor subscription
- Token refresh is automatic when tokens expire
- For enterprise/team accounts, SSO may be required
