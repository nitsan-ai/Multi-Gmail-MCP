import http from "http";
import { URL } from "url";

const CALLBACK_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

const SUCCESS_HTML = `<!DOCTYPE html>
<html>
  <head><title>Authorization Successful</title>
  <style>body{font-family:sans-serif;text-align:center;padding:60px;background:#f5f5f5;}
  .card{background:#fff;border-radius:8px;padding:40px;display:inline-block;box-shadow:0 2px 8px rgba(0,0,0,.1);}
  h1{color:#4caf50;margin-top:0;}p{color:#555;}</style></head>
  <body><div class="card">
    <h1>&#10003; Authorization Successful</h1>
    <p>You can close this tab and return to your application.</p>
  </div></body>
</html>`;

function errorHtml(msg) {
  return `<!DOCTYPE html>
<html>
  <head><title>Authorization Failed</title>
  <style>body{font-family:sans-serif;text-align:center;padding:60px;background:#f5f5f5;}
  .card{background:#fff;border-radius:8px;padding:40px;display:inline-block;box-shadow:0 2px 8px rgba(0,0,0,.1);}
  h1{color:#f44336;margin-top:0;}p{color:#555;}</style></head>
  <body><div class="card">
    <h1>&#10007; Authorization Failed</h1>
    <p>${String(msg).replace(/</g, "&lt;")}</p>
  </div></body>
</html>`;
}

/**
 * Starts a temporary HTTP server on a random available port to capture the OAuth
 * authorization code delivered via Google's loopback redirect.
 *
 * Google ignores the port number for loopback (127.0.0.1) redirect URIs when the
 * app type is "installed", so any ephemeral port works without extra registration.
 *
 * @returns {Promise<{
 *   port: number,
 *   redirectUri: string,
 *   codePromise: Promise<string>,
 *   shutdown: () => void
 * }>}
 */
export function startCallbackServer() {
  return new Promise((resolveServer, rejectServer) => {
    let resolveCode;
    let rejectCode;

    const codePromise = new Promise((res, rej) => {
      resolveCode = res;
      rejectCode = rej;
    });

    const server = http.createServer((req, res) => {
      try {
        const parsed = new URL(req.url, "http://127.0.0.1");
        const code = parsed.searchParams.get("code");
        const error = parsed.searchParams.get("error");

        if (code) {
          res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
          res.end(SUCCESS_HTML);
          resolveCode(code);
          // Close the server shortly after responding so the browser receives the page
          setTimeout(() => { try { server.close(); } catch (_) {} }, 400);
        } else if (error) {
          const description = parsed.searchParams.get("error_description") || error;
          res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
          res.end(errorHtml(description));
          rejectCode(new Error(`OAuth error: ${description}`));
          setTimeout(() => { try { server.close(); } catch (_) {} }, 400);
        } else {
          // Ignore unrelated requests (e.g. favicon)
          res.writeHead(204);
          res.end();
        }
      } catch (err) {
        res.writeHead(500);
        res.end();
        rejectCode(err);
      }
    });

    // Auto-expire after CALLBACK_TIMEOUT_MS
    const timeoutId = setTimeout(() => {
      rejectCode(new Error("OAuth callback timed out — no response received within 5 minutes"));
      try { server.close(); } catch (_) {}
    }, CALLBACK_TIMEOUT_MS);

    // Clear the timeout once the code promise settles
    codePromise.then(
      () => clearTimeout(timeoutId),
      () => clearTimeout(timeoutId)
    );

    server.on("error", (err) => {
      clearTimeout(timeoutId);
      rejectServer(err);
    });

    // Port 0 lets the OS assign a free ephemeral port
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      const redirectUri = `http://127.0.0.1:${port}`;

      const shutdown = () => {
        clearTimeout(timeoutId);
        try { server.close(); } catch (_) {}
      };

      resolveServer({ port, redirectUri, codePromise, shutdown });
    });
  });
}
