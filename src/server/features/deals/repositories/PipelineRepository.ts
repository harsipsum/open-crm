import { and, asc, count, eq, isNotNull, isNull, sql } from "drizzle-orm";
import { db } from "@/db";
import { deal, pipeline, pipelineStage } from "@/db/schema";
import type { DealStage, StageKind } from "@/shared/crm-enums";
import { roundMoney } from "@/shared/currency";
import { OPEN_DEAL_STAGES } from "@/shared/deal-stages";

// Named deal pipelines and their own stages. A deal placed in one keeps a
// built-in stage too: won and lost stages map to CLOSED_WON and CLOSED_LOST,
// the open ones to the built-in open stages by their place, so the Overview
// and every report keep counting it.

export type PipelineStageRef = {
  id: string;
  pipelineId: string;
  kind: StageKind;
  /** The built-in stage it counts as. */
  stage: DealStage;
};

const byName = (column: typeof pipeline.name, name: string) =>
  sql`lower(${column}) = lower(${name})`;

async function findPipeline(organizationId: string, name: string) {
  const [row] = await db
    .select({ id: pipeline.id })
    .from(pipeline)
    .where(
      and(
        eq(pipeline.organizationId, organizationId),
        byName(pipeline.name, name),
      ),
    )
    .limit(1);
  return row?.id ?? null;
}

/** The pipeline of this name, added (last in order) when there's none. */
async function ensurePipeline(
  organizationId: string,
  name: string,
): Promise<string> {
  const found = await findPipeline(organizationId, name);
  if (found) return found;
  const [position] = await db
    .select({ value: count() })
    .from(pipeline)
    .where(eq(pipeline.organizationId, organizationId));
  // Two imports adding it at once: the unique name index keeps one.
  await db
    .insert(pipeline)
    .values({
      id: crypto.randomUUID(),
      organizationId,
      name,
      position: position?.value ?? 0,
    })
    .onConflictDoNothing();
  const id = await findPipeline(organizationId, name);
  if (!id) throw new Error("Pipeline row missing after insert");
  return id;
}

async function stagesOf(organizationId: string, pipelineId: string) {
  return db
    .select({
      id: pipelineStage.id,
      name: pipelineStage.name,
      kind: pipelineStage.kind,
      position: pipelineStage.position,
    })
    .from(pipelineStage)
    .where(
      and(
        eq(pipelineStage.organizationId, organizationId),
        eq(pipelineStage.pipelineId, pipelineId),
      ),
    )
    .orderBy(asc(pipelineStage.position));
}

function builtInStage(kind: StageKind, openPlace: number): DealStage {
  if (kind === "DONE") return "CLOSED_WON";
  if (kind === "DROPPED") return "CLOSED_LOST";
  return (
    OPEN_DEAL_STAGES[Math.min(openPlace, OPEN_DEAL_STAGES.length - 1)] ??
    "DEMO_BOOKED"
  );
}

function refOf(
  pipelineId: string,
  stages: Awaited<ReturnType<typeof stagesOf>>,
  name: string,
): PipelineStageRef | null {
  const index = stages.findIndex(
    (stage) => stage.name.toLowerCase() === name.toLowerCase(),
  );
  const found = stages[index];
  if (!found) return null;
  const openPlace = stages
    .slice(0, index)
    .filter((stage) => stage.kind === "OPEN").length;
  return {
    id: found.id,
    pipelineId,
    kind: found.kind,
    stage: builtInStage(found.kind, openPlace),
  };
}

/**
 * The pipeline's stage of this name, added after its last stage when it
 * has none, as `kind` says.
 */
async function ensureStage(
  organizationId: string,
  pipelineId: string,
  name: string,
  kind: StageKind,
): Promise<PipelineStageRef> {
  const stages = await stagesOf(organizationId, pipelineId);
  const found = refOf(pipelineId, stages, name);
  if (found) return found;
  await db
    .insert(pipelineStage)
    .values({
      id: crypto.randomUUID(),
      organizationId,
      pipelineId,
      name,
      kind,
      position: (stages.at(-1)?.position ?? -1) + 1,
    })
    .onConflictDoNothing();
  const added = refOf(
    pipelineId,
    await stagesOf(organizationId, pipelineId),
    name,
  );
  if (!added) throw new Error("Pipeline stage row missing after insert");
  return added;
}

/** Puts the deal in the pipeline at its stage. */
async function place(
  organizationId: string,
  dealId: string,
  ref: PipelineStageRef,
) {
  await db
    .update(deal)
    .set({ pipelineId: ref.pipelineId, pipelineStageId: ref.id })
    .where(and(eq(deal.organizationId, organizationId), eq(deal.id, dealId)));
}

/**
 * Every pipeline with its stages in order, and per stage the live deals at
 * it: how many, and their amounts per currency.
 */
async function summary(organizationId: string) {
  const [pipelines, stages, totals] = await Promise.all([
    db
      .select({ id: pipeline.id, name: pipeline.name })
      .from(pipeline)
      .where(eq(pipeline.organizationId, organizationId))
      .orderBy(asc(pipeline.position)),
    db
      .select({
        id: pipelineStage.id,
        pipelineId: pipelineStage.pipelineId,
        name: pipelineStage.name,
        kind: pipelineStage.kind,
      })
      .from(pipelineStage)
      .where(eq(pipelineStage.organizationId, organizationId))
      .orderBy(asc(pipelineStage.position)),
    db
      .select({
        stageId: deal.pipelineStageId,
        currency: deal.currency,
        deals: count(),
        amount: sql<number | null>`sum(${deal.amount})`,
      })
      .from(deal)
      .where(
        and(
          eq(deal.organizationId, organizationId),
          isNull(deal.archivedAt),
          isNotNull(deal.pipelineStageId),
        ),
      )
      .groupBy(deal.pipelineStageId, deal.currency),
  ]);
  return pipelines.map((row) => ({
    ...row,
    stages: stages
      .filter((stage) => stage.pipelineId === row.id)
      .map(({ pipelineId: _, ...stage }) => {
        const at = totals.filter((total) => total.stageId === stage.id);
        return {
          ...stage,
          deals: at.reduce((sum, total) => sum + total.deals, 0),
          amountByCurrency: Object.fromEntries(
            at.map((total) => [
              total.currency,
              roundMoney(total.amount ?? 0, total.currency),
            ]),
          ),
        };
      }),
  }));
}

export const PipelineRepository = {
  ensurePipeline,
  ensureStage,
  place,
  summary,
};
