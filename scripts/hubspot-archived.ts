import { sourceRecordSchema, type SourceRecord } from "./hubspot-api.ts";
import type { HubspotReader } from "./hubspot-reader.ts";

function mergePage(full: Map<string, SourceRecord>, rows: SourceRecord[]) {
  for (const row of rows) {
    const old = full.get(row.id);
    if (!old)
      throw new Error(
        "Archived source IDs changed during property read; rerun",
      );
    old.properties = { ...old.properties, ...row.properties };
  }
}

// HubSpot can list an archived record that batch/read and single-ID reads
// return as 404. Read complete property pages instead, retaining every ID.
export async function* readArchived(
  reader: HubspotReader,
  type: string,
  properties: string[],
) {
  let after: string | undefined;
  const cursors = new Set<string>();
  do {
    const full = new Map<string, SourceRecord>();
    let next: string | undefined;
    for (let start = 0; start < properties.length; start += 100) {
      const names = encodeURIComponent(
        properties.slice(start, start + 100).join(","),
      );
      const answer = await reader.request(
        `/crm/v3/objects/${type}?archived=true&limit=100&properties=${names}${after ? `&after=${encodeURIComponent(after)}` : ""}`,
      );
      const rows = answer.results.map((row) => sourceRecordSchema.parse(row));
      if (start === 0) {
        next = answer.paging?.next?.after;
        for (const row of rows) full.set(row.id, row);
        if (!rows.length) break;
      } else {
        if (rows.length !== full.size || answer.paging?.next?.after !== next)
          throw new Error(
            "Archived source changed during property read; rerun",
          );
        mergePage(full, rows);
      }
    }
    if (full.size) yield [...full.values()];
    if (next && cursors.has(next))
      throw new Error("Repeated archived source cursor");
    if (next) cursors.add(next);
    after = next;
  } while (after);
}
