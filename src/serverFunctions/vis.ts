import { createServerFn } from "@tanstack/react-start";
import { ResearchService } from "@/server/features/vis/services/ResearchService";
import { SdrService } from "@/server/features/vis/services/SdrService";
import { VisDealService } from "@/server/features/vis/services/VisDealService";
import { requireAuthenticatedContext } from "@/serverFunctions/middleware";
import { dealIdSchema } from "@/types/schemas/vis";

// The deal sheet's Lead section: what VisCRM knows about the deal's lead,
// and the two things a member does there.

export const getDealLead = createServerFn({ method: "GET" })
  .middleware(requireAuthenticatedContext)
  .validator(dealIdSchema)
  .handler(({ data, context }) =>
    VisDealService.view(context.organizationId, data.dealId),
  );

export const completeFirstCall = createServerFn({ method: "POST" })
  .middleware(requireAuthenticatedContext)
  .validator(dealIdSchema)
  .handler(async ({ data, context }) => {
    await SdrService.completeFirstCall(context.organizationId, data.dealId);
    return { dealId: data.dealId };
  });

export const retryResearch = createServerFn({ method: "POST" })
  .middleware(requireAuthenticatedContext)
  .validator(dealIdSchema)
  .handler(({ data, context }) =>
    ResearchService.retry(context.organizationId, data.dealId),
  );
