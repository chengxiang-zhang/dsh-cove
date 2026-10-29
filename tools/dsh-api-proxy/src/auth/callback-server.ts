import http from "http";
import { URL } from "url";

export interface CallbackResult {
  code: string;
  state: string;
}

const SUCCESS_HTML = `<!DOCTYPE html>
<html><body style="font-family:sans-serif;text-align:center;padding-top:80px">
<h1>Login Successful</h1>
<p>You can close this tab and return to the terminal.</p>
</body></html>`;

export interface CallbackOptions {
  port?: number;
  timeoutMs?: number;
  callbackPath?: string;
}

export function waitForCallback(
  opts: CallbackOptions = {},
): Promise<CallbackResult> {
  const port = opts.port ?? 54545;
  const timeoutMs = opts.timeoutMs ?? 300000;
  const callbackPath = opts.callbackPath ?? "/callback";

  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const url = new URL(req.url || "/", `http://localhost:${port}`);

      if (url.pathname === callbackPath) {
        const error = url.searchParams.get("error");
        if (error) {
          res.writeHead(400, { "Content-Type": "text/plain" });
          res.end(`OAuth error: ${error}`);
          cleanup();
          reject(new Error(`OAuth error: ${error}`));
          return;
        }

        const code = url.searchParams.get("code");
        const state = url.searchParams.get("state");

        if (!code || !state) {
          res.writeHead(400, { "Content-Type": "text/plain" });
          res.end("Missing code or state parameter");
          return; // don't consume the one-shot flow
        }

        // Serve the success page inline. We deliberately don't 302 to a
        // /…/success path because cleanup() closes the server immediately
        // after this request, so the browser would get a connection-refused
        // page when following the redirect.
        res.writeHead(200, { "Content-Type": "text/html" });
        res.end(SUCCESS_HTML);
        cleanup();
        resolve({ code, state });
      } else {
        res.writeHead(404);
        res.end();
      }
    });

    const timer = setTimeout(() => {
      cleanup();
      reject(new Error("OAuth callback timeout"));
    }, timeoutMs);

    function cleanup() {
      clearTimeout(timer);
      server.close();
    }

    server.listen(port, "127.0.0.1", () => {
      console.log(
        `OAuth callback server listening on http://127.0.0.1:${port}${callbackPath}`,
      );
    });
  });
}
