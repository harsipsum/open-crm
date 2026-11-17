import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { z } from "zod";
import { hubspotAnswer, sourceRecordSchema } from "./hubspot-api.ts";
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
export class HubspotReader {
  token: string;
  budgetFile?: string;
  maxRequests: number;
  fetcher: typeof fetch;
  delay: (ms: number) => Promise<void>;
  calls: number;
  nextAt: number;
  budget: { day: string; requests: number };
  constructor(
    token: string,
    {
      budgetFile,
      maxRequests = 10000,
      fetcher = fetch,
      delay = sleep,
    }: {
      budgetFile?: string;
      maxRequests?: number;
      fetcher?: typeof fetch;
      delay?: (ms: number) => Promise<void>;
    } = {},
  ) {
    if (!token) throw new Error("HUBSPOT_TOKEN required");
    this.token = token;
    this.budgetFile = budgetFile;
    this.maxRequests = maxRequests;
    this.fetcher = fetcher;
    this.delay = delay;
    this.calls = 0;
    this.nextAt = 0;
    this.budget = { day: new Date().toISOString().slice(0, 10), requests: 0 };
    if (budgetFile) {
      try {
        const saved = z
          .object({ day: z.string(), requests: z.number().int().nonnegative() })
          .parse(JSON.parse(readFileSync(budgetFile, "utf8")));
        if (saved.day === this.budget.day) this.budget = saved;
      } catch (e) {
        if (!(e instanceof Error && "code" in e && e.code === "ENOENT"))
          throw new Error("Invalid budget file", { cause: e });
      }
    }
  }
  async request(path: string, body?: unknown) {
    // Only allow reads. POST is restricted to HubSpot's batch/read and search.
    if (
      !path.startsWith("/crm/") ||
      (body && !/\/(batch\/read|search)(?:\?|$)/.test(path))
    )
      throw new Error("HubSpot write refused");
    for (let attempt = 0; attempt < 6; attempt++) {
      if (this.calls >= this.maxRequests || this.budget.requests >= 10000)
        throw new Error("Migration API cap reached, rerun after UTC reset");
      await this.delay(Math.max(0, this.nextAt - Date.now()));
      this.nextAt = Date.now() + 150; // below Starter's 100 calls / 10 seconds
      this.calls++;
      this.budget.requests++;
      if (this.budgetFile) {
        mkdirSync(dirname(this.budgetFile), { recursive: true });
        writeFileSync(this.budgetFile, JSON.stringify(this.budget), {
          mode: 0o600,
        });
      }
      const r = await this.fetcher(`https://api.hubapi.com${path}`, {
        method: body ? "POST" : "GET",
        headers: {
          authorization: `Bearer ${this.token}`,
          "content-type": "application/json",
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(60000),
      });
      const remaining = Number(
        r.headers.get("x-hubspot-ratelimit-daily-remaining") ?? "999999",
      );
      if (remaining < 1000)
        throw new Error(
          "HubSpot daily headroom below 1000, stopped before exhaustion",
        );
      if (r.status === 429 || r.status >= 500) {
        if (r.status === 429) {
          const j = z
            .object({ policyName: z.string().optional() })
            .parse(await r.json().catch(() => ({})));
          if (j.policyName === "DAILY")
            throw new Error("HubSpot daily cap reached");
        } else await r.body?.cancel();
        const retry = Number(r.headers.get("retry-after"));
        await this.delay(
          Math.min(
            60000,
            Math.max(
              Number.isFinite(retry) ? retry * 1000 : 0,
              1000 * 2 ** attempt,
            ),
          ),
        );
        continue;
      }
      if (!r.ok) {
        await r.body?.cancel();
        throw new Error(`HubSpot read failed (${r.status})`);
      }
      return hubspotAnswer.parse(await r.json());
    }
    throw new Error("HubSpot retry cap reached");
  }
  async *list(path: string) {
    let after: string | undefined;
    const seen = new Set();
    do {
      const sep = path.includes("?") ? "&" : "?";
      const data = await this.request(
        `${path}${sep}limit=100${after ? `&after=${encodeURIComponent(after)}` : ""}`,
      );
      yield data.results.map((row) => sourceRecordSchema.parse(row));
      after = data.paging?.next?.after;
      if (after && seen.has(String(after)))
        throw new Error("Repeated HubSpot cursor");
      if (after) seen.add(String(after));
    } while (after);
  }
}
