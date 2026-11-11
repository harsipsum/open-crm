import { z } from "zod";
import { dealTool } from "@/server/everyapp/tools/deals";
import { DealService } from "@/server/features/deals/services/DealService";
import { STAGE_KINDS } from "@/shared/crm-enums";

// Named deal pipelines (as an import brings them) as an AI client sees them.

export const pipelineTools = {
  list_pipelines: dealTool({
    description:
      "The named pipelines (as a HubSpot import brings them, like Sales Pipeline and Renewals), each with its own stages in order, what kind each is (OPEN, DONE for won, DROPPED for lost), and the live deals at it: how many and their amounts per currency.",
    risk: "read",
    input: z.object({}).strict(),
    output: z.object({
      pipelines: z.array(
        z.object({
          id: z.string(),
          name: z.string(),
          stages: z.array(
            z.object({
              id: z.string(),
              name: z.string(),
              kind: z.enum(STAGE_KINDS),
              deals: z.number(),
              amountByCurrency: z.record(z.string(), z.number()),
            }),
          ),
        }),
      ),
    }),
    handler: async (_input, context) => ({
      pipelines: await DealService.listPipelines(context.organizationId),
    }),
  }),
};
