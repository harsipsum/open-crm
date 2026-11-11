import { z } from "zod";
import { dealTool } from "@/server/everyapp/tools/deals";
import { DealService } from "@/server/features/deals/services/DealService";
import { STAGE_KINDS } from "@/shared/crm-enums";

// Named deal pipelines (as an import brings them) as an AI client sees them.

const pipelineOutput = z.object({
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
});

export const pipelineTools = {
  list_pipelines: dealTool({
    description:
      "The named pipelines (as a HubSpot import brings them, like Sales Pipeline and Renewals), each with its own stages in order, what kind each is (OPEN, DONE for won, DROPPED for lost), and the live deals at it: how many and their amounts per currency.",
    risk: "read",
    input: z.object({}).strict(),
    output: z.object({ pipelines: z.array(pipelineOutput) }),
    handler: async (_input, context) => ({
      pipelines: await DealService.listPipelines(context.organizationId),
    }),
  }),

  set_pipeline_stages: dealTool({
    description:
      "Put a named pipeline's stages in its real order, first to last (an import adds them as it first sees them: open ones first, then won, then lost). A stage it lacks is added, won/renewed as a win, lost/churned/unqualified as a loss, any other open; stages left out stay after these. Open deals then count as the built-in open stage at their stage's new place; won and lost deals don't move. Returns the pipeline as list_pipelines shows it.",
    risk: "write",
    input: z
      .object({
        pipeline: z
          .string()
          .trim()
          .min(1)
          .max(120)
          .describe("The pipeline's name, as list_pipelines shows it."),
        stages: z
          .array(z.string().trim().min(1).max(120))
          .min(1)
          .max(50)
          .refine(
            (names) =>
              new Set(names.map((name) => name.toLowerCase())).size ===
              names.length,
            "Each stage once.",
          )
          .describe("Its stage names, first to last."),
      })
      .strict(),
    output: pipelineOutput,
    handler: (input, context) =>
      DealService.orderPipelineStages(context.organizationId, input),
  }),
};
