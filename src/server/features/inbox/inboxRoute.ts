import { env } from "cloudflare:workers";
import { resolveUserContextFromHeaders } from "@/middleware/ensure-user/resolve";
import { inboxCss, inboxHtml, inboxJs } from "./ui";

// The Inbox inside the CRM: the page and its assets under /_inbox/, and its
// API under /_inbox/api/*, which goes on to the Inbox engine (the wa-cloud
// Worker: WhatsApp and social sessions in Durable Objects, the AI agent and
// the conversations) with the CRM's token and the signed-in member's email as
// the actor. The browser never holds the token. The engine's CRM queue is not
// reachable from here: only the cron's sync reads it (inboxCrmSync.ts).
export const INBOX_PREFIX = "/_inbox";
const DEFAULT_ENGINE = "https://wa-cloud.harsos-hamza.workers.dev";

export function isInboxPath(pathname: string): boolean {
  return pathname === INBOX_PREFIX || pathname.startsWith(`${INBOX_PREFIX}/`);
}

export function inboxEngine(): { url: string; token: string } | null {
  const token = env.INBOX_API_TOKEN;
  if (!token) return null;
  return { url: env.INBOX_API_URL || DEFAULT_ENGINE, token };
}

const PAGE_HEADERS = {
  "cache-control": "no-store",
  "referrer-policy": "no-referrer",
};

export async function serveInbox(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const rest = url.pathname.slice(INBOX_PREFIX.length);
  if (rest === "")
    return Response.redirect(`${url.origin}${INBOX_PREFIX}/`, 302);
  if (rest === "/app.js") {
    return new Response(inboxJs, {
      headers: {
        ...PAGE_HEADERS,
        "content-type": "text/javascript; charset=utf-8",
      },
    });
  }
  if (rest === "/app.css") {
    return new Response(inboxCss, {
      headers: { ...PAGE_HEADERS, "content-type": "text/css; charset=utf-8" },
    });
  }
  if (rest.startsWith("/api/"))
    return proxy(request, rest.slice(5), url.search);
  return new Response(inboxHtml({ title: "Inbox · OpenCRM", crmBase: "" }), {
    headers: {
      ...PAGE_HEADERS,
      "content-type": "text/html; charset=utf-8",
      "content-security-policy":
        "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; frame-ancestors 'self'",
    },
  });
}

async function proxy(
  request: Request,
  path: string,
  search: string,
): Promise<Response> {
  const engine = inboxEngine();
  if (!engine) {
    return Response.json(
      {
        error:
          "The Inbox isn't connected: set INBOX_API_TOKEN (everyapp configure).",
      },
      { status: 503 },
    );
  }
  // Server-only parts of the engine stay server-only.
  if (/^c\/[^/]+\/crm\//.test(path) || /^c\/[^/]+\/settings/.test(path)) {
    return Response.json({ error: "Not found" }, { status: 404 });
  }
  const user = await resolveUserContextFromHeaders(request.headers);
  const init: RequestInit = {
    method: request.method,
    headers: {
      authorization: `Bearer ${engine.token}`,
      "content-type": "application/json",
      "x-inbox-actor": user.userEmail,
    },
  };
  if (request.method === "POST" || request.method === "PUT") {
    init.body = await request.text();
  }
  const upstream = await fetch(
    `${engine.url}/inbox-api/${path}${search}`,
    init,
  );
  return new Response(upstream.body, {
    status: upstream.status,
    headers: {
      "content-type": "application/json",
      "cache-control": "no-store",
    },
  });
}
