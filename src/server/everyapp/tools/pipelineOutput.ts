import { z } from "zod";

/** A deal's place in a named pipeline, as deal tools show it. */
export const pipelineOutput = {
  pipeline: z
    .string()
    .nullable()
    .describe("The named pipeline it is in (from an import), if any."),
  pipelineStage: z
    .string()
    .nullable()
    .describe("Its stage in that pipeline; `stage` is what it counts as."),
};
