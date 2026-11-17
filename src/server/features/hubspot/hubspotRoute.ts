import { getOptionalEnvValue } from "@/server/lib/runtime-env";
import { HubspotRepository } from "./HubspotRepository";
import {
  hubspotAssociationsSchema,
  hubspotBatchSchema,
} from "@/types/schemas/hubspot";

const LIMIT = 2 * 1024 * 1024;
function json(status: number, data: unknown) {
  return Response.json(data, {
    status,
    headers: { "cache-control": "no-store" },
  });
}

async function authorized(request: Request) {
  const secret = await getOptionalEnvValue("HUBSPOT_IMPORT_KEY");
  const org = await getOptionalEnvValue("EVERY_APP_ORG_ID");
  const presented = /^Bearer (.+)$/i.exec(
    request.headers.get("authorization") ?? "",
  )?.[1];
  if (!secret || !org || !presented || presented.length > 512) return null;
  const algorithm = { name: "HMAC", hash: "SHA-256" };
  const bytes = new TextEncoder();
  const expected = await crypto.subtle.importKey(
    "raw",
    bytes.encode(secret),
    algorithm,
    false,
    ["sign"],
  );
  const actual = await crypto.subtle.importKey(
    "raw",
    bytes.encode(presented),
    algorithm,
    false,
    ["verify"],
  );
  const message = bytes.encode("hubspot-import");
  const signature = await crypto.subtle.sign("HMAC", expected, message);
  return (await crypto.subtle.verify("HMAC", actual, signature, message))
    ? org
    : null;
}

async function body(request: Request) {
  if (Number(request.headers.get("content-length")) > LIMIT)
    throw new Error("size");
  const reader = request.body?.getReader();
  if (!reader) throw new Error("json");
  const parts: Uint8Array[] = [];
  let length = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    length += value.byteLength;
    if (length > LIMIT) {
      await reader.cancel();
      throw new Error("size");
    }
    parts.push(value);
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) {
    bytes.set(part, offset);
    offset += part.length;
  }
  return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
}

// Migration writes bypass all normal intake/stage services. Neither historical
// wins, contacts, notes nor associations can emit webhooks or Asana writes.
export async function serveHubspotImport(request: Request): Promise<Response> {
  const org = await authorized(request);
  if (!org)
    return json(401, {
      error: "Import key required, with a pinned organization.",
    });
  const url = new URL(request.url);
  if (request.method === "GET" && url.pathname.endsWith("/counts")) {
    const portal = url.searchParams.get("portalId") ?? "";
    if (!/^\d{1,20}$/.test(portal))
      return json(422, { error: "Portal ID required." });
    return json(200, {
      ...(await HubspotRepository.counts(org, portal)),
      asanaEnabled: (await getOptionalEnvValue("ASANA_WON_ENABLED")) === "1",
    });
  }
  if (request.method !== "POST") return json(405, { error: "POST required." });
  try {
    const raw = await body(request);
    if (url.pathname.endsWith("/objects")) {
      const parsed = hubspotBatchSchema.safeParse(raw);
      if (!parsed.success) return json(422, { error: "Invalid object batch." });
      return json(200, await HubspotRepository.writeObjects(org, parsed.data));
    }
    if (url.pathname.endsWith("/associations")) {
      const parsed = hubspotAssociationsSchema.safeParse(raw);
      if (!parsed.success)
        return json(422, { error: "Invalid association batch." });
      return json(
        200,
        await HubspotRepository.writeAssociations(org, parsed.data),
      );
    }
    return json(404, { error: "Not found." });
  } catch (error) {
    if (error instanceof Error && error.message === "size")
      return json(413, { error: "Batch exceeds 2 MB." });
    if (error instanceof SyntaxError)
      return json(400, { error: "Invalid JSON." });
    // Never put source properties, SQL bindings or provider responses in logs.
    console.error("[hubspot] import batch failed");
    return json(500, {
      error:
        "Import batch failed. No success receipt was issued; safe to rerun.",
    });
  }
}
