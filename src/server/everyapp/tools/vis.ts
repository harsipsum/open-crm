import { z } from "zod";
import { requireOrgPermission } from "@/server/auth/org-gate";
import { dealTool } from "@/server/everyapp/tools/deals";
import { AsanaHandoffService } from "@/server/features/vis/services/AsanaHandoffService";
import { IntakeService } from "@/server/features/vis/services/IntakeService";
import { KeyService } from "@/server/features/vis/services/KeyService";
import { ResearchService } from "@/server/features/vis/services/ResearchService";
import { SdrService } from "@/server/features/vis/services/SdrService";
import { VisDealService } from "@/server/features/vis/services/VisDealService";
import { VisTickService } from "@/server/features/vis/services/VisTickService";
import { VIS_APPS, VISTAR_PIPELINE } from "@/shared/vis";
import {
  appSchema,
  dealIdSchema,
  leadSchema,
  orderSchema,
  stageMoveSchema,
} from "@/types/schemas/vis";

// VisCRM as an AI client sees it: set up the pipeline, mint the sibling
// apps' keys (owners and admins), create and move leads, read a deal's lead
// view, and run the minute's tick now. The sibling apps themselves write
// through the keyed API (visApiRoute.ts), not these.

const anyOutput = z.object({}).loose();

export const visTools = {
  vis_setup_pipeline: dealTool({
    description: `Set up VisCRM's ${VISTAR_PIPELINE.name} with Vistar's HubSpot stages in order (${VISTAR_PIPELINE.stages.join(", ")}). Safe to run again.`,
    risk: "write",
    input: z.object({}).strict(),
    output: anyOutput,
    handler: async (_input, context) => {
      requireOrgPermission(context, { workspace: ["manage"] });
      return IntakeService.setupPipeline(context.organizationId);
    },
  }),

  vis_mint_app_key: dealTool({
    description: `Mint the write key for one sibling app (${VIS_APPS.join(", ")}), revoking its old one. The key is shown only in this answer: put it straight into the app's secrets. Owners and admins only.`,
    risk: "write",
    input: appSchema,
    output: z.object({
      app: z.enum(VIS_APPS),
      key: z.string(),
      scopes: z.array(z.string()),
    }),
    handler: async (input, context) => {
      requireOrgPermission(context, { workspace: ["manage"] });
      return KeyService.mint(context.organizationId, input.app, context.userId);
    },
  }),

  list_app_keys: dealTool({
    description:
      "The sibling apps' write keys: which app, its prefix, when it was last used and whether it's revoked. Never the key itself.",
    risk: "read",
    input: z.object({}).strict(),
    output: z.object({ keys: z.array(anyOutput) }),
    handler: async (_input, context) => ({
      keys: await KeyService.list(context.organizationId),
    }),
  }),

  vis_revoke_app_key: dealTool({
    description:
      "Revoke a sibling app's live write key. Owners and admins only.",
    risk: "write",
    input: appSchema,
    output: z.object({ app: z.enum(VIS_APPS), revoked: z.boolean() }),
    handler: async (input, context) => {
      requireOrgPermission(context, { workspace: ["manage"] });
      return KeyService.revoke(context.organizationId, input.app);
    },
  }),

  vis_create_lead: dealTool({
    description:
      "Create a lead as the system does at first touch: its company, contact and a deal at Lead Generated, with source, campaign, creative, click ids, consent, product, order type and a fit score. Inbound sources get the SDR's 5-minute call task.",
    risk: "write",
    input: leadSchema,
    output: anyOutput,
    handler: (input, context) =>
      IntakeService.createLead(context.organizationId, input, null),
  }),

  vis_move_stage: dealTool({
    description: `Move a deal to one of the ${VISTAR_PIPELINE.name}'s stages by name, exactly. A lost deal needs a reason.`,
    risk: "write",
    input: stageMoveSchema,
    output: anyOutput,
    handler: (input, context) =>
      IntakeService.moveToStage(
        context.organizationId,
        input,
        null,
        context.userId,
      ),
  }),

  vis_set_order: dealTool({
    description:
      "Set what was sold on a deal, as the Asana intake asks for it: license revenue, implementation value and whether it's required, Asana license type, users, Freshworks products. Only what is given changes.",
    risk: "write",
    input: orderSchema,
    output: anyOutput,
    handler: async (input, context) => ({
      order: await VisDealService.setOrder(context.organizationId, input),
    }),
  }),

  get_deal_lead: dealTool({
    description:
      "A deal's lead view: source, click ids, consent, product and fit score; its research (company, person, brief) with the cost per lead; the SDR's first-call timer; the offline conversions it sent; and its Asana task.",
    risk: "read",
    input: dealIdSchema,
    output: anyOutput,
    handler: (input, context) =>
      VisDealService.view(context.organizationId, input.dealId),
  }),

  vis_complete_first_call: dealTool({
    description: "The SDR made the first call on a deal: tick its task off.",
    risk: "write",
    input: dealIdSchema,
    output: z.object({ firstCall: anyOutput.nullable() }),
    handler: async (input, context) => ({
      firstCall: await SdrService.completeFirstCall(
        context.organizationId,
        input.dealId,
      ),
    }),
  }),

  vis_retry: dealTool({
    description:
      "Ask again for a deal's waiting research and a failed Asana handoff.",
    risk: "write",
    input: dealIdSchema,
    output: anyOutput,
    handler: async (input, context, call) => ({
      research: await ResearchService.retry(
        context.organizationId,
        input.dealId,
      ),
      asanaTaskGid: await AsanaHandoffService.retry(
        context.organizationId,
        input.dealId,
        call.origin,
      ),
    }),
  }),

  vis_run_tick: dealTool({
    description:
      "Run the minute's VisCRM work now for this organization: SDR timers, research, conversions and the won handoff.",
    risk: "write",
    input: z.object({}).strict(),
    output: anyOutput,
    handler: (_input, context, call) =>
      VisTickService.tickOrganization(
        context.organizationId,
        call.origin,
        new Date().toISOString(),
      ),
  }),
};
