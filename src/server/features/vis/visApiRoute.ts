import type { z } from "zod";
import { serveHubspotImport } from "@/server/features/hubspot/hubspotRoute";
import { KeyService } from "@/server/features/vis/services/KeyService";
import { IntakeService } from "@/server/features/vis/services/IntakeService";
import { LeadMatchService } from "@/server/features/vis/services/LeadMatchService";
import { ResearchService } from "@/server/features/vis/services/ResearchService";
import { VisDealService } from "@/server/features/vis/services/VisDealService";
import { asAppError } from "@/server/lib/errors";
import { getOptionalEnvValue } from "@/server/lib/runtime-env";
import type { VisScope } from "@/shared/vis";
import {
  consentSchema,
  lookupSchema,
  leadSchema,
  noteSchema,
  orderSchema,
  researchFillSchema,
  stageMoveSchema,
} from "@/types/schemas/vis";

// Star CRM's write API for the sibling apps (everyapp.config.ts `public`):
// the gateway forwards it with no identity, so every call carries its app's
// key in `x-viscrm-key`, and the key alone names the organization (pinned to
// EVERY_APP_ORG_ID where the deploy pins one) and what it may do:
//
//   POST /api/vis/v1/leads                    leads:write
//   GET  /api/vis/v1/leads?email=|phone=      deals:read
//   GET  /api/vis/v1/deals/<id>               deals:read
//   POST /api/vis/v1/deals/<id>/notes         notes:write
//   POST /api/vis/v1/deals/<id>/stage         stage:write
//   POST /api/vis/v1/deals/<id>/order         stage:write
//   POST /api/vis/v1/deals/<id>/research      research:write
//   POST /api/vis/v1/deals/<id>/consent       leads:write
//
// Bodies are JSON, at most 64 KB, checked by the same schemas the tools use.

const VIS_API_PREFIX = "/api/vis/v1/";
const MAX_BODY_BYTES = 64 * 1024;
const DEAL_PATH =
  /^\/api\/vis\/v1\/deals\/([^/]+)(?:\/(notes|stage|order|research|consent))?$/;

const STATUS: Record<string, number> = {
  UNAUTHENTICATED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  VALIDATION_ERROR: 422,
  CONFLICT: 409,
  RATE_LIMITED: 429,
};

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

async function bodyOf<S extends z.ZodType>(
  request: Request,
  schema: S,
  extra: Record<string, unknown> = {},
): Promise<z.output<S> | Response> {
  // Refused before it's read when it says it's too big, and measured in
  // bytes (not characters) when it doesn't.
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (declared > MAX_BODY_BYTES) {
    return json(413, { error: "Body over 64 KB." });
  }
  const bytes = new Uint8Array(await request.arrayBuffer());
  if (bytes.byteLength > MAX_BODY_BYTES) {
    return json(413, { error: "Body over 64 KB." });
  }
  const text = new TextDecoder().decode(bytes);
  let raw: unknown;
  try {
    raw = text ? JSON.parse(text) : {};
  } catch {
    return json(400, { error: "Body is not JSON." });
  }
  const parsed = schema.safeParse(
    typeof raw === "object" && raw !== null ? { ...raw, ...extra } : raw,
  );
  if (!parsed.success) {
    return json(422, {
      error: "Invalid body.",
      issues: parsed.error.issues.slice(0, 10).map((issue) => ({
        path: issue.path.join("."),
        message: issue.message,
      })),
    });
  }
  return parsed.data;
}

async function caller(request: Request, scope: VisScope) {
  return KeyService.authenticate(
    request.headers.get("x-viscrm-key"),
    scope,
    await getOptionalEnvValue("EVERY_APP_ORG_ID"),
  );
}

async function route(request: Request): Promise<Response> {
  const { pathname } = new URL(request.url);
  if (pathname === `${VIS_API_PREFIX}leads` && request.method === "POST") {
    const who = await caller(request, "leads:write");
    const input = await bodyOf(request, leadSchema);
    if (input instanceof Response) return input;
    const lead = await IntakeService.createLead(
      who.organizationId,
      input,
      who.app,
    );
    // 201 when a deal was made or joined; 200 for a possible match that
    // wrote nothing.
    return json(lead.dealId ? 201 : 200, lead);
  }
  if (pathname === `${VIS_API_PREFIX}leads` && request.method === "GET") {
    const who = await caller(request, "deals:read");
    const params = new URL(request.url).searchParams;
    const query = lookupSchema.safeParse({
      ...(params.get("email") ? { email: params.get("email") } : {}),
      ...(params.get("phone") ? { phone: params.get("phone") } : {}),
    });
    if (!query.success)
      return json(422, { error: "Give an email or a phone." });
    return json(
      200,
      await LeadMatchService.lookup(who.organizationId, query.data),
    );
  }
  const match = DEAL_PATH.exec(pathname);
  if (!match) return json(404, { error: "Not found." });
  const dealId = decodeURIComponent(match[1] ?? "");
  const action = match[2];
  if (!action && request.method === "GET") {
    const who = await caller(request, "deals:read");
    return json(200, await VisDealService.view(who.organizationId, dealId));
  }
  if (request.method !== "POST")
    return json(405, { error: "Method not allowed." });
  if (action === "notes") {
    const who = await caller(request, "notes:write");
    const input = await bodyOf(request, noteSchema, { dealId });
    if (input instanceof Response) return input;
    return json(
      201,
      await IntakeService.addNote(
        who.organizationId,
        dealId,
        input.body,
        who.app,
      ),
    );
  }
  if (action === "stage") {
    const who = await caller(request, "stage:write");
    const input = await bodyOf(request, stageMoveSchema, { dealId });
    if (input instanceof Response) return input;
    return json(
      200,
      await IntakeService.moveToStage(who.organizationId, input, who.app),
    );
  }
  if (action === "order") {
    const who = await caller(request, "stage:write");
    const input = await bodyOf(request, orderSchema, { dealId });
    if (input instanceof Response) return input;
    return json(200, await VisDealService.setOrder(who.organizationId, input));
  }
  if (action === "consent") {
    const who = await caller(request, "leads:write");
    const input = await bodyOf(request, consentSchema, { dealId });
    if (input instanceof Response) return input;
    return json(
      200,
      await VisDealService.setConsent(who.organizationId, input),
    );
  }
  if (action === "research") {
    const who = await caller(request, "research:write");
    const input = await bodyOf(request, researchFillSchema, { dealId });
    if (input instanceof Response) return input;
    return json(
      200,
      await ResearchService.fill(who.organizationId, input, who.app),
    );
  }
  return json(404, { error: "Not found." });
}

export function isVisApiPath(pathname: string) {
  return pathname.startsWith(VIS_API_PREFIX);
}

/** Answers one API call; an AppError becomes its status and message. */
export async function serveVisApi(request: Request): Promise<Response> {
  if (new URL(request.url).pathname.startsWith("/api/vis/v1/hubspot/"))
    return serveHubspotImport(request);
  try {
    return await route(request);
  } catch (error) {
    const appError = asAppError(error);
    if (appError && appError.code !== "INTERNAL_ERROR") {
      return json(STATUS[appError.code] ?? 400, {
        error: appError.message,
        code: appError.code,
      });
    }
    console.error("[vis] api failed", {
      error: error instanceof Error ? error.name : "unknown",
    });
    return json(500, { error: "Internal error." });
  }
}
