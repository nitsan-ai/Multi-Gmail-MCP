import { promises as fs } from "fs";
import { google } from "googleapis";
import { env } from "../config/env.js";
import { SCOPES } from "../config/constants.js";
import { AppError } from "../utils/errors.js";

async function readCredentialsFile() {
  const filePath = env.GOOGLE_CREDENTIALS_PATH;
  try {
    const raw = await fs.readFile(filePath, "utf8");
    return JSON.parse(raw);
  } catch (error) {
    if (error.code === "ENOENT") {
      throw new AppError(
        `Google credentials file not found at ${filePath}`,
        "CREDENTIALS_NOT_FOUND",
        500
      );
    }
    if (error.code) {
      // Real FS error (EACCES, ENODIR, etc.) — re-throw unchanged so caller sees actual cause
      throw error;
    }
    throw new AppError("Invalid credentials.json format", "INVALID_CREDENTIALS_FILE", 500);
  }
}

export async function createOAuthClient() {
  const credentials = await readCredentialsFile();
  const config = credentials.installed || credentials.web;

  if (!config?.client_id || !config?.client_secret || !config?.redirect_uris?.length) {
    throw new AppError(
      "credentials.json must include client_id, client_secret, and redirect_uris",
      "INVALID_CREDENTIALS_FILE",
      500
    );
  }

  return new google.auth.OAuth2(config.client_id, config.client_secret, config.redirect_uris[0]);
}

export function buildAuthUrl(oauth2Client) {
  return oauth2Client.generateAuthUrl({
    access_type: "offline",
    prompt: "consent",
    scope: SCOPES
  });
}

/**
 * Builds an authorization URL that redirects to a custom URI (e.g. a local
 * loopback server) instead of the one baked into credentials.json.
 * Google ignores the port for 127.0.0.1 loopback URIs on installed apps, so
 * any ephemeral port works without registering it in the Cloud Console.
 */
export function buildAuthUrlWithRedirect(oauth2Client, redirectUri) {
  return oauth2Client.generateAuthUrl({
    access_type: "offline",
    prompt: "consent",
    scope: SCOPES,
    redirect_uri: redirectUri
  });
}

/**
 * Exchanges an authorization code for OAuth tokens.
 * When a custom redirectUri was used to build the auth URL it must be passed
 * here too — Google validates that it matches the one from the original request.
 */
export async function exchangeCodeForTokens(oauth2Client, code, redirectUri) {
  const request = redirectUri ? { code, redirect_uri: redirectUri } : code;
  const { tokens } = await oauth2Client.getToken(request);
  return tokens;
}
