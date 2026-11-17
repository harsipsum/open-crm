import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import {
  TasksPage,
  myTasksQueryOptions,
} from "@/client/features/activities/TasksPage";
import { pageHead } from "@/client/lib/page-title";
import { queryClient } from "@/client/tanstack-db";
import { TASK_WINDOWS } from "@/types/schemas/activities";

const tasksSearchSchema = z.object({
  window: z.enum(TASK_WINDOWS).optional().catch(undefined),
});

export const Route = createFileRoute("/_app/tasks")({
  head: () => pageHead("Tasks"),
  validateSearch: tasksSearchSchema,
  // The loader fills the module-scoped query client, so keep it out of server
  // requests: one isolate must not cache another member's tasks.
  ssr: false,
  loaderDeps: ({ search }) => ({ window: search.window ?? "all" }),
  loader: ({ deps }) => {
    void queryClient.prefetchQuery(myTasksQueryOptions(deps.window));
  },
  component: TasksPage,
});
