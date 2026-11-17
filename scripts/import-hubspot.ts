#!/usr/bin/env node
// No record content, API responses or credentials are logged or persisted.
// A bounded, idempotent full replay is also the recovery path after a failure.
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { sortBy } from "remeda";
import { readArchived } from "./hubspot-archived.ts";
import {
  associationRowSchema,
  associationTargetSchema,
  crmAnswer,
  pipelineSchema,
  propertySchema,
  sourceRecordSchema,
  type SourceRecord,
  type AssociationTarget,
} from "./hubspot-api.ts";

const TYPES = ["companies", "contacts", "deals", "notes"];
const OPEN_STAGES = [
  "DEMO_BOOKED",
  "QUALIFIED_TO_BUY",
  "DECISION_MAKER_BOUGHT_IN",
  "CONTRACT_SENT",
];
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

import { HubspotReader } from "./hubspot-reader.ts";

function mergeProperties(full: Map<string, SourceRecord>, records: unknown[]) {
  for (const raw of records) {
    const record = sourceRecordSchema.parse(raw);
    const existing = full.get(record.id);
    if (!existing) throw new Error("Unexpected HubSpot object ID");
    existing.properties = { ...existing.properties, ...record.properties };
  }
}

export async function runImport({
  baseUrl,
  key,
  token,
  portalId,
  budgetFile,
  maxRequests = 10000,
  phase = "all",
  fromType: resumeFrom,
}: {
  baseUrl: string;
  key: string;
  token: string;
  portalId: string;
  budgetFile?: string;
  maxRequests?: number;
  phase?: string;
  fromType?: string;
}) {
  const base = new URL(baseUrl);
  if (
    base.protocol !== "https:" &&
    !["127.0.0.1", "localhost"].includes(base.hostname)
  )
    throw new Error("CRM requires HTTPS");
  if (base.username || base.password || base.search || base.hash)
    throw new Error("Clean CRM base URL required");
  if (!key || !/^\d+$/.test(portalId))
    throw new Error("CRM key and portal ID required");
  if (resumeFrom && !TYPES.includes(resumeFrom))
    throw new Error("Invalid resume object type");
  const hs = new HubspotReader(token, { budgetFile, maxRequests });
  const receipt = {
    source: {} as Record<string, { active: number; archived: number }>,
    imported: {} as Record<string, number>,
    created: {} as Record<string, number>,
    associations: 0,
    apiCalls: 0,
    before: {} as unknown,
    after: {} as unknown,
  };
  async function crm(action: string, payload?: Record<string, unknown>) {
    for (let retry = 0; retry < 5; retry++) {
      const r = await fetch(new URL(`/api/vis/v1/hubspot/${action}`, base), {
        method: payload ? "POST" : "GET",
        headers: {
          authorization: `Bearer ${key}`,
          "content-type": "application/json",
        },
        ...(payload ? { body: JSON.stringify({ portalId, ...payload }) } : {}),
        redirect: "error",
        signal: AbortSignal.timeout(90000),
      });
      if (r.status === 429 || r.status >= 500) {
        await r.body?.cancel();
        await sleep(1000 * 2 ** retry);
        continue;
      }
      if (!r.ok) {
        await r.body?.cancel();
        throw new Error(
          `CRM import failed (${r.status}), ${action.split("?")[0]}`,
        );
      }
      return crmAnswer.parse(await r.json());
    }
    throw new Error("CRM retry cap reached");
  }
  const before = await crm(`counts?portalId=${portalId}`);
  async function objects(objectType: string, records: SourceRecord[]) {
    for (let i = 0; i < records.length; i += 25) {
      const batch = records.slice(i, i + 25);
      // Bound by bytes too: a large source note must not be dropped.
      if (
        Buffer.byteLength(JSON.stringify(batch)) > 1900000 &&
        batch.length > 1
      ) {
        for (const row of batch) await objects(objectType, [row]);
        continue;
      }
      const result = await crm("objects", { objectType, records: batch });
      if (
        typeof result.received !== "number" ||
        typeof result.created !== "number"
      )
        throw new Error("Invalid import receipt");
      receipt.imported[objectType] =
        (receipt.imported[objectType] ?? 0) + result.received;
      receipt.created[objectType] =
        (receipt.created[objectType] ?? 0) + result.created;
    }
  }
  const ids: Record<string, string[]> = {};
  if (phase !== "associations") {
    receipt.source.owners = { active: 0, archived: 0 };
    for (const archived of [false, true]) {
      for await (const rows of hs.list(
        `/crm/v3/owners/?archived=${archived}`,
      )) {
        receipt.source.owners[archived ? "archived" : "active"] += rows.length;
        await objects(
          "owners",
          rows.map((row) => ({ ...row, archived })),
        );
      }
    }
    const pipelineAnswer = await hs.request("/crm/v3/pipelines/deals");
    const pipelines = pipelineAnswer.results.map((row) =>
      pipelineSchema.parse(row),
    );
    await objects("pipelines", pipelines);
    receipt.source.pipelines = { active: pipelines.length, archived: 0 };
    receipt.source.stages = {
      active: pipelines.reduce((sum, p) => sum + p.stages.length, 0),
      archived: 0,
    };
    for (const p of pipelines) {
      let open = 0;
      const stages = sortBy(p.stages, (s) => s.displayOrder).map((s) => {
        const closed = String(s.metadata?.isClosed) === "true";
        const kind = closed
          ? Number(s.metadata?.probability) === 1
            ? "DONE"
            : "DROPPED"
          : "OPEN";
        const builtInStage =
          kind === "DONE"
            ? "CLOSED_WON"
            : kind === "DROPPED"
              ? "CLOSED_LOST"
              : OPEN_STAGES[Math.min(open++, OPEN_STAGES.length - 1)];
        return {
          ...s,
          id: `${p.id}:${s.id}`,
          hubspotId: s.id,
          pipelineId: p.id,
          stageKind: kind,
          builtInStage,
        };
      });
      await objects("stages", stages);
    }
  }
  async function copyType(type: string) {
    const writeType =
      phase !== "associations" &&
      (!resumeFrom || TYPES.indexOf(type) >= TYPES.indexOf(resumeFrom));
    ids[type] = [];
    const schema = await hs.request(`/crm/v3/properties/${type}`);
    const properties = schema.results.map((row) => propertySchema.parse(row));
    const props = properties.map((p) => p.name);
    if (writeType)
      await objects(
        "schemas",
        properties.map((p) => ({ ...p, id: `${type}:${p.name}` })),
      );
    const total = await hs.request(`/crm/v3/objects/${type}/search`, {
      limit: 1,
    });
    if (typeof total.total !== "number") throw new Error("Missing API total");
    receipt.source[type] = { active: total.total, archived: 0 };
    for (const archived of [false]) {
      for await (const page of hs.list(
        `/crm/v3/objects/${type}?archived=${archived}`,
      )) {
        const batchIds = page.map((r) => r.id);
        ids[type].push(...batchIds);
        if (archived) receipt.source[type].archived += page.length;
        if (!writeType) continue;
        const full = new Map<string, SourceRecord>(
          page.map((r) => [r.id, { ...r, properties: {} }]),
        );
        for (let start = 0; start < props.length; start += 500) {
          const answer = await hs.request(
            `/crm/v3/objects/${type}/batch/read?archived=${archived}`,
            {
              inputs: batchIds.map((id) => ({ id })),
              properties: props.slice(start, start + 500),
            },
          );
          if (
            answer.errors?.length ||
            answer.status !== "COMPLETE" ||
            answer.results?.length !== batchIds.length
          )
            throw new Error(`Incomplete HubSpot ${type} batch`);
          mergeProperties(full, answer.results);
        }
        await objects(type, [...full.values()]);
        console.log(
          JSON.stringify({
            objectType: type,
            read: ids[type].length,
            created: receipt.created[type] ?? 0,
            apiCalls: hs.calls,
          }),
        );
      }
    }
    for await (const page of readArchived(hs, type, props)) {
      ids[type].push(...page.map((row) => row.id));
      receipt.source[type].archived += page.length;
      if (writeType) await objects(type, page);
    }
    const activeCount = ids[type].length - receipt.source[type].archived;
    if (activeCount !== total.total)
      throw new Error(`Source changed during ${type} read, rerun to reconcile`);
  }
  for (const type of TYPES) await copyType(type);
  async function copyPair(fromType: string, toType: string) {
    for (let i = 0; i < ids[fromType].length; i += 100) {
      const result = await hs.request(
        `/crm/v4/associations/${fromType}/${toType}/batch/read`,
        { inputs: ids[fromType].slice(i, i + 100).map((id) => ({ id })) },
      );
      if (
        result.status !== "COMPLETE" ||
        result.errors?.some(
          (e) => e.subCategory !== "crm.associations.NO_ASSOCIATIONS_FOUND",
        )
      )
        throw new Error("Incomplete HubSpot association batch");
      const edges: {
        fromType: string;
        fromId: string;
        toType: string;
        toId: string;
        typeId: string;
        category: string;
        label: string | null;
      }[] = [];
      const append = (fromId: string, values: AssociationTarget[]) => {
        for (const to of values)
          for (const t of to.associationTypes)
            edges.push({
              fromType,
              fromId: String(fromId),
              toType,
              toId: String(to.toObjectId),
              typeId: String(t.typeId),
              category: t.category,
              label: t.label ?? null,
            });
      };
      for (const raw of result.results) {
        const row = associationRowSchema.parse(raw);
        append(row.from.id, row.to ?? []);
        let after = row.paging?.next?.after;
        const cursors = new Set();
        while (after) {
          if (cursors.has(String(after)))
            throw new Error("Repeated association cursor");
          cursors.add(String(after));
          const next = await hs.request(
            `/crm/v4/objects/${fromType}/${row.from.id}/associations/${toType}?limit=500&after=${encodeURIComponent(after)}`,
          );
          append(
            row.from.id,
            next.results.map((r) => associationTargetSchema.parse(r)),
          );
          after = next.paging?.next?.after;
        }
      }
      for (let j = 0; j < edges.length; j += 100) {
        await crm("associations", { records: edges.slice(j, j + 100) });
        receipt.associations += Math.min(100, edges.length - j);
      }
    }
    console.log(
      JSON.stringify({
        associations: `${fromType}:${toType}`,
        written: receipt.associations,
        apiCalls: hs.calls,
      }),
    );
  }
  if (phase !== "objects") {
    for (const fromType of TYPES)
      for (const toType of TYPES) await copyPair(fromType, toType);
  }
  const after = await crm(`counts?portalId=${portalId}`);
  for (const type of TYPES) {
    const row = after.objects.find((r) => r.objectType === type);
    if (
      row?.active !== receipt.source[type].active ||
      row?.count !== ids[type].length ||
      after.projections[type] !== ids[type].length
    )
      throw new Error(`CRM ${type} count mismatch`);
  }
  if (phase !== "objects" && after.associations !== receipt.associations)
    throw new Error("Association count mismatch");
  receipt.apiCalls = hs.calls;
  receipt.before = before;
  receipt.after = after;
  console.log(JSON.stringify({ completed: true, receipt }));
  return receipt;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  runImport({
    baseUrl: process.env.STAR_CRM_URL ?? "",
    key: process.env.STAR_CRM_KEY ?? "",
    token: process.env.HUBSPOT_TOKEN ?? "",
    portalId: process.env.HUBSPOT_PORTAL_ID ?? "9344866",
    budgetFile:
      process.env.HUBSPOT_BUDGET_FILE ??
      resolve(".everyapp/hubspot-api-budget.json"),
    maxRequests: Number(process.env.HUBSPOT_MAX_REQUESTS ?? 10000),
    phase: process.env.HUBSPOT_IMPORT_PHASE ?? "all",
    fromType: process.env.HUBSPOT_IMPORT_FROM,
  }).catch((e) => {
    console.error(e instanceof Error ? e.message : "Import failed");
    process.exitCode = 1;
  });
}
