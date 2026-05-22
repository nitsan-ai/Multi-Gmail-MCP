import { exec } from "child_process";
import { writeTokens } from "./token-store.js";
import { createOAuthClient, buildAuthUrlWithRedirect, exchangeCodeForTokens } from "./oauth-client.js";
import { startCallbackServer } from "./local-callback-server.js";
import { logger } from "../utils/logger.js";
import { assertAlias } from "../utils/validators.js";

function parseAliasFromArgs(argv) {
  for (const flag of ["--alias", "--account"]) {
    const i = argv.indexOf(flag);
    if (i !== -1 && argv[i + 1]) {
      return { alias: argv[i + 1], explicit: true };
    }
  }
  return { alias: "default", explicit: false };
}

/**
 * Attempts to open a URL in the system default browser.
 * Falls back silently if the command is unavailable (the URL is always printed).
 */
function openBrowser(url) {
  const platform = process.platform;
  let cmd;
  if (platform === "win32") cmd = `start "" "${url}"`;
  else if (platform === "darwin") cmd = `open "${url}"`;
  else cmd = `xdg-open "${url}"`;

  exec(cmd, (err) => {
    if (err) {
      // Non-fatal — user can open the printed URL manually
    }
  });
}

async function main() {
  const { alias: rawAlias, explicit } = parseAliasFromArgs(process.argv);
  if (!explicit) {
    console.log(
      'No --alias (or --account) given; using alias "default". ' +
        "For another mailbox, run: npm run auth -- --alias <name>\n"
    );
  }
  const alias = assertAlias(rawAlias);

  // 1. Start a local loopback server so the auth code is captured automatically
  const { redirectUri, codePromise, shutdown } = await startCallbackServer();

  // 2. Build the authorization URL pointing at our local server
  const oauth2Client = await createOAuthClient();
  const authUrl = buildAuthUrlWithRedirect(oauth2Client, redirectUri);

  // 3. Print the URL and try to open the browser automatically
  console.log(`\nAuthorizing alias "${alias}"\n`);
  console.log("Opening your browser for Google authorization…");
  console.log("\nIf your browser does not open, visit this URL manually:\n");
  console.log(authUrl);
  console.log(
    `\nWaiting for Google to redirect to ${redirectUri} …\n` +
    "(You do NOT need to copy or paste anything — authorization completes automatically)\n"
  );

  openBrowser(authUrl);

  // 4. Wait for the code to arrive via the browser redirect (no user input needed)
  let authCode;
  try {
    authCode = await codePromise;
  } catch (err) {
    shutdown();
    throw new Error(`Authorization failed: ${err.message}`);
  }

  // 5. Exchange the code for tokens and persist them
  const tokens = await exchangeCodeForTokens(oauth2Client, authCode, redirectUri);
  await writeTokens(alias, tokens);

  logger.info("Account authorization completed", { alias });
  console.log(`\nSuccess! Tokens saved for alias "${alias}".\n`);
}

main().catch((error) => {
  logger.error("Account authorization failed", { message: error.message });
  process.exit(1);
});
