import { createMiddleware } from "@tanstack/react-start";
import { z } from "zod";
import { AppError } from "@/server/lib/errors";
import { errorHandlingMiddleware } from "@/middleware/errorHandling";
import type { EnsuredUserContext } from "@/middleware/ensure-user/types";
import { ensureUserMiddleware } from "@/middleware/ensureUser";
import {
  resolveAccess,
  runWithAccess,
  type Access,
} from "@/server/features/access/access";
import {
  auditDetail,
  recordAudit,
} from "@/server/features/access/AuditRepository";

const ensuredUserContextSchema: z.ZodType<EnsuredUserContext> = z.object({
  userId: z.string(),
  userEmail: z.string(),
  organizationId: z.string(),
  role: z.string(),
});

function getAuthenticatedContext(context: unknown): EnsuredUserContext {
  const result = ensuredUserContextSchema.safeParse(context);
  if (!result.success) {
    throw new AppError(
      "INTERNAL_ERROR",
      "Authenticated server function context missing",
    );
  }
  return result.data;
}

export const globalServerFunctionMiddleware = [
  errorHandlingMiddleware,
  ensureUserMiddleware,
] as const;

type ScopedContext = EnsuredUserContext & { access: Access };

// Every server function runs as the signed-in member inside their Access
// (src/server/features/access/access.ts), which narrows the deals and
// contacts they read and write. Every POST is a write, and lands in the
// audit log with its outcome.
export const requireAuthenticatedContext = [
  createMiddleware({ type: "function" }).server(
    async ({ next, context, data, method, serverFnMeta }) => {
      const authenticated = getAuthenticatedContext(context);
      const access = await resolveAccess(authenticated);
      const scoped: ScopedContext = { ...authenticated, access };
      return runWithAccess(access, async () => {
        if (method !== "POST") return next({ context: scoped });
        const { recordId, detail } = auditDetail(data);
        const entry = {
          organizationId: authenticated.organizationId,
          actorId: authenticated.userId,
          actorKind: "member" as const,
          action: serverFnMeta?.name ?? "unknown",
          recordId,
          detail,
        };
        try {
          const result = await next({ context: scoped });
          await recordAudit({ ...entry, outcome: "ok" });
          return result;
        } catch (error) {
          await recordAudit({ ...entry, outcome: "error" });
          throw error;
        }
      });
    },
  ),
] as const;
