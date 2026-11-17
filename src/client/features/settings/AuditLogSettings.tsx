import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import {
  SettingsCard,
  SettingsSection,
} from "@/client/components/SettingsSection";
import { Button } from "@/client/components/ui/button";
import { RelativeTime } from "@/client/features/records/LocalDateTime";
import { teamQueryOptions } from "@/client/features/settings/SalesTeamSettings";
import { getAuditLog } from "@/serverFunctions/team";

/** "setDealStage" or "vis:lead" or "tool:update_deal" as words. */
function actionWords(action: string): string {
  const [, rest = action] = action.match(/^(?:vis|tool):(.+)$/) ?? [];
  return rest
    .replace(/[_-]+/g, " ")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .toLowerCase();
}

/** Every write anyone made, newest first: who, what, on which record. */
export function AuditLogSettings() {
  const team = useQuery(teamQueryOptions());
  const log = useInfiniteQuery({
    queryKey: ["audit-log"],
    queryFn: ({ pageParam }) => getAuditLog({ data: { before: pageParam } }),
    initialPageParam: null as string | null,
    getNextPageParam: (page) =>
      page.length === 100 ? (page.at(-1)?.at ?? null) : null,
  });
  const names = new Map(
    (team.data ?? []).map((member) => [member.userId, member.name]),
  );
  const rows = log.data?.pages.flat() ?? [];

  return (
    <SettingsSection
      id="audit-log"
      title="Audit log"
      description="Every change to a record, by a person, an app or an agent."
    >
      <SettingsCard>
        {log.isPending ? (
          <div className="h-16 animate-pulse" />
        ) : rows.length === 0 ? (
          <p className="px-4 py-3 text-sm text-muted-foreground">
            Nothing changed yet.
          </p>
        ) : (
          <ul className="max-h-96 divide-y divide-border overflow-auto">
            {rows.map((row) => (
              <li
                key={row.id}
                className="grid grid-cols-[1fr_auto] gap-x-3 px-4 py-2 text-sm"
              >
                <span className="min-w-0 truncate">
                  <span className="font-medium">
                    {(row.actorId && names.get(row.actorId)) ??
                      row.actorId ??
                      "Unknown"}
                  </span>{" "}
                  {actionWords(row.action)}
                  {row.outcome === "error" ? (
                    <span className="text-destructive"> (failed)</span>
                  ) : null}
                </span>
                <span className="text-xs whitespace-nowrap text-muted-foreground">
                  <RelativeTime date={row.at} />
                </span>
              </li>
            ))}
          </ul>
        )}
        {log.hasNextPage ? (
          <div className="px-4 py-2">
            <Button
              variant="outline"
              size="sm"
              disabled={log.isFetchingNextPage}
              onClick={() => void log.fetchNextPage()}
            >
              Show older
            </Button>
          </div>
        ) : null}
      </SettingsCard>
    </SettingsSection>
  );
}
