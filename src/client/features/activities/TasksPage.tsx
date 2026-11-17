import type { ReactNode } from "react";
import { queryOptions, useQuery } from "@tanstack/react-query";
import { getRouteApi } from "@tanstack/react-router";
import { AlarmClock, CalendarClock, ListTodo } from "lucide-react";
import { cn } from "cn";
import { EmptyState } from "@/client/components/EmptyState";
import { PageHeader } from "@/client/components/PageHeader";
import { QueryError } from "@/client/components/QueryState";
import { SegmentedToggle } from "@/client/components/SegmentedToggle";
import {
  AboutRecord,
  TaskCheckbox,
} from "@/client/features/activities/TaskParts";
import { activityKeys } from "@/client/features/activities/activityQueries";
import { RelativeDay } from "@/client/features/records/LocalDateTime";
import { getMyTasks } from "@/serverFunctions/activities";
import type { TaskWindow } from "@/types/schemas/activities";

const routeApi = getRouteApi("/_app/tasks");

export const myTasksQueryOptions = (window: TaskWindow) =>
  queryOptions({
    queryKey: [...activityKeys.all, "mine", window] as const,
    queryFn: () => getMyTasks({ data: { window, limit: 100 } }),
  });

const WINDOW_ITEMS = [
  { value: "all", label: "Open", icon: <ListTodo className="size-3.5" /> },
  {
    value: "overdue",
    label: "Overdue",
    icon: <AlarmClock className="size-3.5" />,
  },
  {
    value: "upcoming",
    label: "Upcoming",
    icon: <CalendarClock className="size-3.5" />,
  },
] satisfies { value: TaskWindow; label: string; icon: ReactNode }[];

/** /tasks: the open tasks you set, soonest due first, ticked off in place. */
export function TasksPage() {
  const search = routeApi.useSearch();
  const navigate = routeApi.useNavigate();
  const window = search.window ?? "all";
  const tasks = useQuery(myTasksQueryOptions(window));
  const now = new Date();

  return (
    <div className="flex h-full flex-col overflow-auto px-4 py-4 pb-24 md:px-6 md:py-6 md:pb-8">
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-4">
        <PageHeader
          title="Tasks"
          description="What you set yourself to do, soonest due first."
          actions={
            <SegmentedToggle<TaskWindow>
              showLabels
              value={window}
              onChange={(next) =>
                void navigate({
                  search: { window: next === "all" ? undefined : next },
                  replace: true,
                })
              }
              items={WINDOW_ITEMS}
            />
          }
        />
        {tasks.isError ? (
          <QueryError
            error={tasks.error}
            fallback="Couldn't load your tasks."
            onRetry={() => void tasks.refetch()}
            isRetrying={tasks.isFetching}
          />
        ) : tasks.isPending ? (
          <div className="h-32 animate-pulse rounded-xl bg-muted/60" />
        ) : tasks.data.length === 0 ? (
          <EmptyState
            variant="card"
            icon={ListTodo}
            title={window === "overdue" ? "Nothing overdue" : "No open tasks"}
            description="Add a task from any contact, company or deal."
          />
        ) : (
          <ul className="divide-y divide-border rounded-xl border border-border bg-card">
            {tasks.data.map((task) => (
              <li
                key={task.id}
                className="flex items-center gap-3 px-4 py-3 text-sm"
              >
                <span className="flex">
                  <TaskCheckbox task={task} />
                </span>
                {/* One line: the task, then the record it's about, then when. */}
                <span className="flex min-w-0 flex-1 flex-wrap items-baseline gap-x-3">
                  <span className="min-w-0 truncate">{task.subject}</span>
                  <span className="flex min-w-0 text-muted-foreground">
                    <AboutRecord entry={task} />
                  </span>
                </span>
                {task.dueAt ? (
                  <span
                    className={cn(
                      "text-xs whitespace-nowrap",
                      new Date(task.dueAt) < now
                        ? "text-destructive"
                        : "text-muted-foreground",
                    )}
                  >
                    <RelativeDay date={task.dueAt} />
                  </span>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
