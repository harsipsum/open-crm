import type { DealStage, StageKind } from "@/shared/crm-enums";

// What a deal's stage means: where it sits in the pipeline, whether the deal
// is still open, and what people call it. The deals feature owns it;
// companies count and order a company's deals by it.

/** The buying stages, in the order a deal moves through them. */
export const BUYING_DEAL_STAGES = [
  "LEAD",
  "DEMO_BOOKED",
  "MQL",
  "QUALIFIED_TO_BUY",
  "TECHNICAL_EVALUATION",
  "PROPOSAL",
  "DECISION_MAKER_BOUGHT_IN",
  "BEST_CASE",
  "COMMIT",
  "CONTRACT_SENT",
] as const satisfies readonly DealStage[];

/**
 * Every open stage: the buying stages, a deal paused on hold (a status, not a
 * step forward), and a named stage no rule maps (`UNMAPPED`), which reports
 * still count so no open money goes missing.
 */
export const OPEN_DEAL_STAGES: DealStage[] = [
  ...BUYING_DEAL_STAGES,
  "ON_HOLD",
  "UNMAPPED",
];

/** Outcomes: a deal moved into one is closed, and when is recorded. */
export const CLOSED_DEAL_STAGES: DealStage[] = [
  "CLOSED_WON",
  "CLOSED_LOST",
  "UNQUALIFIED_TO_BUY",
];

/** Every stage in pipeline order: the open ones, then the outcomes. */
export const DEAL_STAGE_ORDER = [
  ...OPEN_DEAL_STAGES,
  "CLOSED_WON",
  "CLOSED_LOST",
  "UNQUALIFIED_TO_BUY",
] as const satisfies readonly DealStage[];

/**
 * Outcomes that take a reason: a lost deal with no reason teaches nobody
 * anything.
 */
const LOSING_DEAL_STAGES: DealStage[] = ["CLOSED_LOST", "UNQUALIFIED_TO_BUY"];

export const DEAL_STAGE_LABELS: Record<DealStage, string> = {
  LEAD: "Lead",
  DEMO_BOOKED: "Demo booked",
  MQL: "MQL",
  QUALIFIED_TO_BUY: "Qualified to buy (SQL)",
  TECHNICAL_EVALUATION: "Technical evaluation",
  PROPOSAL: "Proposal",
  DECISION_MAKER_BOUGHT_IN: "Decision maker in",
  BEST_CASE: "Best case",
  COMMIT: "Commit",
  CONTRACT_SENT: "Contract sent",
  ON_HOLD: "On hold",
  UNMAPPED: "Unmapped stage",
  CLOSED_WON: "Closed won",
  CLOSED_LOST: "Closed lost",
  UNQUALIFIED_TO_BUY: "Unqualified",
};

/**
 * A named open stage's built-in stage, by its name. Vistar's Sales Pipeline,
 * HubSpot's default pipeline and HubSpot's Shared Selling Pipeline. A name
 * missing here is UNMAPPED: the built-in stage is never guessed from a
 * stage's place, because a pipeline longer than the buying ladder pushed
 * every later stage onto CONTRACT_SENT.
 */
const OPEN_STAGE_BY_NAME: Record<string, DealStage> = {
  // Vistar's Sales Pipeline.
  "lead generated": "LEAD",
  "initial meeting / demo": "DEMO_BOOKED",
  "on hold": "ON_HOLD",
  mql: "MQL",
  sql: "QUALIFIED_TO_BUY",
  "technical demo / poc / integration discussion": "TECHNICAL_EVALUATION",
  "proposal discussion / budget qualified": "PROPOSAL",
  "best case": "BEST_CASE",
  "forecast commit": "COMMIT",
  // HubSpot's default sales pipeline.
  "appointment scheduled": "DEMO_BOOKED",
  "qualified to buy": "QUALIFIED_TO_BUY",
  "presentation scheduled": "TECHNICAL_EVALUATION",
  "decision maker bought-in": "DECISION_MAKER_BOUGHT_IN",
  "contract sent": "CONTRACT_SENT",
  // HubSpot's Shared Selling Pipeline.
  discovery: "DEMO_BOOKED",
  "solution demo": "TECHNICAL_EVALUATION",
  "pricing and terms": "PROPOSAL",
  "out for signature": "CONTRACT_SENT",
  // The CRM's own stage names, as a stage made from a built-in one carries.
  ...Object.fromEntries(
    [...BUYING_DEAL_STAGES, "ON_HOLD" as const].map((stage) => [
      DEAL_STAGE_LABELS[stage].toLowerCase(),
      stage,
    ]),
  ),
};

/** The lookup key of a stage name: lower case, one space between words. */
function stageNameKey(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, " ");
}

/**
 * The built-in stage a named pipeline stage maps to: won and lost by kind,
 * an open stage by its name, UNMAPPED when its name has no rule.
 */
export function builtInStageOf(name: string, kind: StageKind): DealStage {
  if (kind === "DONE") return "CLOSED_WON";
  if (kind === "DROPPED") return "CLOSED_LOST";
  return OPEN_STAGE_BY_NAME[stageNameKey(name)] ?? "UNMAPPED";
}

/** Every stage-name key that maps to an open built-in stage. */
export function openStageNamesOf(stage: DealStage): string[] {
  return Object.entries(OPEN_STAGE_BY_NAME)
    .filter(([, mapped]) => mapped === stage)
    .map(([name]) => name);
}

export function isClosedStage(stage: DealStage): boolean {
  return CLOSED_DEAL_STAGES.includes(stage);
}

export function isLosingStage(stage: DealStage): boolean {
  return LOSING_DEAL_STAGES.includes(stage);
}
