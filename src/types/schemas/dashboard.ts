import { z } from "zod";

/** Whose numbers Home shows: the viewer's own deals, or the whole team's. */
export const DASHBOARD_SCOPES = ["me", "everyone"] as const;
export type DashboardScope = (typeof DASHBOARD_SCOPES)[number];

export const dashboardSummarySchema = z.object({
  scope: z.enum(DASHBOARD_SCOPES).default("everyone"),
  /**
   * The end of the viewer's day, from their browser: tasks due before it are
   * today's follow-ups. Without it the day ends at midnight UTC.
   */
  dayEnd: z.iso.datetime().optional(),
});
