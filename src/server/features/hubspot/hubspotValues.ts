import { sql } from "drizzle-orm";
import type { HubspotBatch } from "@/types/schemas/hubspot";
export type Source = HubspotBatch["records"][number];
const prefix = (org: string, portal: string) => `hs:${org}:${portal}:`;
export const target = (org: string, portal: string, type: string, id: string) =>
  `${prefix(org, portal)}${type}:${id}`;
export const text = (v: unknown) =>
  typeof v === "string" && v.trim() ? v.trim() : null;
export const date = (v: unknown) => {
  if (typeof v !== "string" || !v) return null;
  const d = new Date(/^\d+$/.test(v) ? Number(v) : v);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
};
export function lookup(
  org: string,
  portal: string,
  type: string,
  id: string | null,
) {
  return sql<
    string | null
  >`(select target_id from hubspot_object where organization_id = ${org} and portal_id = ${portal} and object_type = ${type} and source_id = ${id})`;
}
export function rawProperties(row: Source) {
  return row.properties ?? {};
}
