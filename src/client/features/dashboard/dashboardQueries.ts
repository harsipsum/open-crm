import { keepPreviousData, queryOptions } from "@tanstack/react-query";
import { getDashboardSummary } from "@/serverFunctions/dashboard";
import type { DashboardScope } from "@/types/schemas/dashboard";

export const dashboardKeys = {
  all: ["dashboard"] as const,
  summary: (scope: DashboardScope, dayEnd: string) =>
    ["dashboard", "summary", scope, dayEnd] as const,
};

/** The end of the viewer's local day, as an instant. */
function localDayEnd(): string {
  const end = new Date();
  end.setHours(24, 0, 0, 0);
  return end.toISOString();
}

/** Home's figures and lists, for the viewer's deals or everyone's. */
export const dashboardSummaryQueryOptions = (scope: DashboardScope) => {
  const dayEnd = localDayEnd();
  return queryOptions({
    queryKey: dashboardKeys.summary(scope, dayEnd),
    queryFn: () => getDashboardSummary({ data: { scope, dayEnd } }),
    // Switching scope keeps the figures on screen until the others arrive.
    placeholderData: keepPreviousData,
  });
};
