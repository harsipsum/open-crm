import { useQueries } from "@tanstack/react-query";
import {
  DndContext,
  PointerSensor,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import { useState, type ReactNode } from "react";
import { toast } from "sonner";
import { cn } from "cn";
import { CloseReasonDialog } from "@/client/features/deals/DealStage";
import { formatAmount, type DealRow } from "@/client/features/deals/dealFormat";
import { dealListQueryOptions } from "@/client/features/deals/dealQueries";
import { useSetDealStage } from "@/client/features/deals/useDealMutations";
import { DEAL_STAGE_LABELS, DEAL_STAGE_ORDER } from "@/shared/deal-stages";
import type { DealStage } from "@/shared/crm-enums";
import type { DealListInput } from "@/types/schemas/deals";

/** How many cards a column shows; the table shows the rest. */
const PER_COLUMN = 50;
const NEEDS_REASON: DealStage[] = ["CLOSED_LOST", "UNQUALIFIED_TO_BUY"];

/**
 * The pipeline as a board: a column per stage with the deals the filters
 * leave, most recently worked first. Dragging a card to a column moves the
 * deal there; a lost or unqualified drop asks why first.
 */
export function DealBoard({
  input,
  onOpen,
}: {
  input: DealListInput;
  onOpen: (dealId: string) => void;
}) {
  const columns = useQueries({
    queries: DEAL_STAGE_ORDER.map((stage) =>
      dealListQueryOptions({
        ...input,
        status: "all",
        stage: [stage],
        sort: "lastActivity",
        dir: "desc",
        page: 1,
        pageSize: PER_COLUMN,
      }),
    ),
  });
  const setStage = useSetDealStage((changed) => {
    if (changed) toast.success("Deal moved.");
  });
  const [closing, setClosing] = useState<{
    id: string;
    stage: DealStage;
  } | null>(null);
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
  );

  const onDragEnd = ({ active, over }: DragEndEvent) => {
    if (!over) return;
    const stage = over.id as DealStage;
    const from = active.data.current?.stage as DealStage | undefined;
    if (!from || from === stage) return;
    const id = String(active.id);
    if (NEEDS_REASON.includes(stage)) {
      setClosing({ id, stage });
      return;
    }
    setStage.mutate({ id, stage });
  };

  if (columns.some((column) => column.isError)) {
    return <p className="text-sm text-destructive">Couldn't load the board.</p>;
  }
  return (
    <DndContext sensors={sensors} onDragEnd={onDragEnd}>
      <div className="flex min-h-0 flex-1 gap-3 overflow-x-auto pb-3 [scrollbar-color:auto] [&::-webkit-scrollbar]:h-2.5 [&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-thumb]:bg-border [&::-webkit-scrollbar-track]:bg-transparent">
        {DEAL_STAGE_ORDER.map((stage, index) => {
          const column = columns[index];
          const rows = column?.data?.rows ?? [];
          const total = column?.data?.total ?? 0;
          return (
            <BoardColumn
              key={stage}
              stage={stage}
              total={total}
              value={column?.data?.openValue ?? null}
              currency={column?.data?.reportingCurrency ?? null}
            >
              {column?.isPending ? (
                <div className="h-16 animate-pulse rounded-lg bg-background/60" />
              ) : (
                rows.map((row) => (
                  <BoardCard
                    key={row.id}
                    row={row}
                    onOpen={() => onOpen(row.id)}
                  />
                ))
              )}
              {total > rows.length ? (
                <p className="px-1.5 text-xs text-muted-foreground">
                  {total - rows.length} more in the table
                </p>
              ) : null}
            </BoardColumn>
          );
        })}
      </div>
      {closing ? (
        <CloseReasonDialog
          stage={closing.stage}
          onClose={() => setClosing(null)}
          onSave={async (closedReason) => {
            await setStage.mutateAsync({ ...closing, closedReason });
            setClosing(null);
          }}
        />
      ) : null}
    </DndContext>
  );
}

function BoardColumn({
  stage,
  total,
  value,
  currency,
  children,
}: {
  stage: DealStage;
  total: number;
  value: number | null;
  currency: string | null;
  children: ReactNode;
}) {
  const { setNodeRef, isOver } = useDroppable({ id: stage });
  return (
    <section
      ref={setNodeRef}
      aria-label={DEAL_STAGE_LABELS[stage]}
      className={cn(
        "flex w-64 shrink-0 flex-col gap-2 rounded-xl bg-muted/60 p-2 transition-colors",
        isOver && "bg-primary/10 ring-2 ring-primary/30",
      )}
    >
      <h3 className="flex items-baseline gap-1.5 px-1.5 pt-1 text-xs font-semibold">
        {DEAL_STAGE_LABELS[stage]}
        <span className="font-normal text-muted-foreground tabular-nums">
          {total}
        </span>
        {value && currency ? (
          <span className="ml-auto font-normal text-muted-foreground tabular-nums">
            {formatAmount(value, currency)}
          </span>
        ) : null}
      </h3>
      <div className="flex min-h-24 flex-col gap-2">{children}</div>
    </section>
  );
}

function BoardCard({ row, onOpen }: { row: DealRow; onOpen: () => void }) {
  const { attributes, listeners, setNodeRef, transform, isDragging } =
    useDraggable({ id: row.id, data: { stage: row.stage } });
  return (
    <button
      ref={setNodeRef}
      type="button"
      {...attributes}
      {...listeners}
      onClick={onOpen}
      style={
        transform
          ? { transform: `translate3d(${transform.x}px, ${transform.y}px, 0)` }
          : undefined
      }
      className={cn(
        "flex w-full flex-col gap-0.5 rounded-lg border border-border bg-card px-3 py-2 text-left text-sm shadow-xs transition-shadow hover:border-foreground/20",
        isDragging && "relative z-10 shadow-lg",
      )}
    >
      <span className="truncate font-medium">{row.name}</span>
      <span className="flex items-baseline justify-between gap-2 text-xs text-muted-foreground">
        <span className="truncate">{row.company.name}</span>
        {row.amount !== null ? (
          <span className="shrink-0 tabular-nums">
            {formatAmount(row.amount, row.currency)}
          </span>
        ) : null}
      </span>
    </button>
  );
}
