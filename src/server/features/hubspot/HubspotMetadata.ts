import { and, eq, sql } from "drizzle-orm";
import { db } from "@/db";
import {
  hubspotObject,
  member,
  pipeline,
  pipelineStage,
  user,
} from "@/db/schema";
import { target, text, type Source } from "./hubspotValues";
export async function metadataWrite({
  org,
  portal,
  kind,
  row,
  createdAt,
}: {
  org: string;
  portal: string;
  kind: string;
  row: Source;
  createdAt: string;
}) {
  if (!["owners", "pipelines", "stages"].includes(kind)) return null;
  let id = target(org, portal, kind, row.id);
  const writes: Promise<unknown>[] = [];
  if (kind === "owners") {
    const email = text(row.email)?.toLowerCase();
    const found = email
      ? await db
          .select({ id: user.id })
          .from(user)
          .where(eq(user.email, email))
          .limit(1)
      : [];
    id = found[0]?.id ?? id;
    const value = {
      id,
      name:
        [text(row.firstName), text(row.lastName)].filter(Boolean).join(" ") ||
        "HubSpot owner",
      email: email ?? `${encodeURIComponent(id)}@import.invalid`,
    };
    writes.push(db.insert(user).values(value).onConflictDoNothing());
    writes.push(
      db
        .insert(member)
        .values({
          id: target(org, portal, "members", row.id),
          organizationId: org,
          userId: id,
          role: "member",
          createdAt: new Date(createdAt),
        })
        .onConflictDoNothing(),
    );
  } else if (kind === "pipelines") {
    const name = text(row.label) ?? row.id;
    const found = await db
      .select({ id: pipeline.id })
      .from(pipeline)
      .where(
        and(
          eq(pipeline.organizationId, org),
          sql`lower(${pipeline.name}) = lower(${name})`,
        ),
      )
      .limit(1);
    id = found[0]?.id ?? id;
    const value = {
      id,
      organizationId: org,
      name,
      position: Number(row.displayOrder ?? 0),
      createdAt,
    };
    writes.push(
      db
        .insert(pipeline)
        .values(value)
        .onConflictDoUpdate({
          target: pipeline.id,
          set: { name, position: value.position },
          setWhere: eq(pipeline.organizationId, org),
        }),
    );
  } else if (kind === "stages") {
    const parentId = text(row.pipelineId);
    const [parent] = await db
      .select({ id: hubspotObject.targetId })
      .from(hubspotObject)
      .where(
        and(
          eq(hubspotObject.organizationId, org),
          eq(hubspotObject.portalId, portal),
          eq(hubspotObject.objectType, "pipelines"),
          eq(hubspotObject.sourceId, parentId ?? ""),
        ),
      );
    if (!parent) throw new Error("Import pipelines before their stages");
    const name = text(row.label) ?? row.id;
    const found = await db
      .select({ id: pipelineStage.id })
      .from(pipelineStage)
      .where(
        and(
          eq(pipelineStage.organizationId, org),
          eq(pipelineStage.pipelineId, parent.id),
          sql`lower(${pipelineStage.name}) = lower(${name})`,
        ),
      )
      .limit(1);
    id = found[0]?.id ?? id;
    const stageKind =
      row.stageKind === "DONE"
        ? "DONE"
        : row.stageKind === "DROPPED"
          ? "DROPPED"
          : "OPEN";
    const value = {
      id,
      organizationId: org,
      pipelineId: parent.id,
      name,
      kind: stageKind,
      position: Number(row.displayOrder ?? 0),
    } as const;
    writes.push(
      db
        .insert(pipelineStage)
        .values(value)
        .onConflictDoUpdate({
          target: pipelineStage.id,
          set: { name, kind: stageKind, position: value.position },
          setWhere: eq(pipelineStage.organizationId, org),
        }),
    );
  }
  return { id, writes };
}
