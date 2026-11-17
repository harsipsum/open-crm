import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Badge } from "@/client/components/ui/badge";
import { Button } from "@/client/components/ui/button";
import { RelativeTime } from "@/client/features/records/LocalDateTime";
import { SheetSection } from "@/client/features/records/RecordSheet";
import {
  completeFirstCall,
  getDealLead,
  retryResearch,
} from "@/serverFunctions/vis";
import { ORDER_TYPE_LABELS, PRODUCT_LABELS } from "@/shared/vis";

// A deal's Lead section (VisCRM): where the lead came from, set by the
// system at first touch; its research and what it cost; the SDR's first
// call; the offline conversions it sent; and its Asana task. Deals VisCRM
// didn't create show nothing here.

const leadKey = (dealId: string) => ["deals", "lead", dealId] as const;

/** The brief's sections, as the SDR reads them. */
const BRIEF_LABELS: Record<string, string> = {
  account: "Account",
  whyNow: "Why now",
  whoToCall: "Who to call",
  fit: "Fit",
  product: "Product",
  source: "Source",
};

function usd(value: number) {
  return `USD ${value.toFixed(value < 1 ? 3 : 2)}`;
}

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-4 text-sm">
      <dt className="shrink-0 text-muted-foreground">{label}</dt>
      <dd className="min-w-0 text-right [overflow-wrap:anywhere]">
        {value ?? "—"}
      </dd>
    </div>
  );
}

export function DealLead({ dealId }: { dealId: string }) {
  const queryClient = useQueryClient();
  const query = useQuery({
    queryKey: leadKey(dealId),
    queryFn: () => getDealLead({ data: { dealId } }),
  });
  const refresh = () =>
    void queryClient.invalidateQueries({ queryKey: ["deals"] });
  const called = useMutation({
    mutationFn: () => completeFirstCall({ data: { dealId } }),
    onSuccess: () => {
      toast.success("First call logged");
      refresh();
    },
  });
  const retry = useMutation({
    mutationFn: () => retryResearch({ data: { dealId } }),
    onSuccess: refresh,
  });

  const view = query.data;
  const lead = view?.lead;
  if (!view || !lead) return null;
  const clickIds = [
    ["gclid", lead.gclid],
    ["fbclid", lead.fbclid],
    ["ctwa_clid", lead.ctwaClid],
    ["li_fat_id", lead.liFatId],
  ].filter(([, value]) => value);
  const brief = view.research.find((row) => row.kind === "BRIEF");
  const briefSections = brief?.brief ? Object.entries(brief.brief) : [];
  const waiting = view.research.some((row) => row.status === "PENDING");

  return (
    <>
      <SheetSection title={`Lead · fit ${lead.fitScore}/100`}>
        <dl className="space-y-1">
          <Row
            label="Source"
            value={lead.source.replaceAll("_", " ").toLowerCase()}
          />
          <Row label="Campaign" value={lead.campaign} />
          <Row label="Creative" value={lead.creativeId} />
          <Row
            label="First touch"
            value={<RelativeTime date={lead.firstTouchAt} />}
          />
          <Row
            label="Click ids"
            value={
              clickIds.length
                ? clickIds.map(([name]) => name).join(", ")
                : "none"
            }
          />
          <Row label="Consent" value={lead.consent.toLowerCase()} />
          <Row
            label="Product"
            value={
              lead.product
                ? `${PRODUCT_LABELS[lead.product]} · ${ORDER_TYPE_LABELS[lead.orderType]}`
                : ORDER_TYPE_LABELS[lead.orderType]
            }
          />
          {lead.createdByApp ? (
            <Row label="Created by" value={lead.createdByApp} />
          ) : null}
        </dl>
        <ul className="list-disc pl-4 text-xs text-muted-foreground">
          {lead.fitReasons.map((reason) => (
            <li key={reason}>{reason}</li>
          ))}
        </ul>
      </SheetSection>

      {view.firstCall ? (
        <SheetSection
          title="First call"
          action={
            view.firstCall.status === "OPEN" ? (
              <Button
                variant="ghost"
                size="xs"
                disabled={called.isPending}
                onClick={() => called.mutate()}
              >
                Called
              </Button>
            ) : null
          }
        >
          <dl className="space-y-1">
            <Row
              label="Status"
              value={
                <Badge
                  variant={
                    view.firstCall.status === "ESCALATED"
                      ? "destructive"
                      : view.firstCall.status === "DONE"
                        ? "secondary"
                        : "default"
                  }
                >
                  {view.firstCall.status.toLowerCase()}
                </Badge>
              }
            />
            <Row
              label="Due"
              value={<RelativeTime date={view.firstCall.dueAt} />}
            />
            <Row
              label="Escalates"
              value={<RelativeTime date={view.firstCall.escalateAt} />}
            />
          </dl>
        </SheetSection>
      ) : null}

      <SheetSection
        title={`Research · ${usd(view.costPerLeadUsd)} this lead`}
        action={
          waiting ? (
            <Button
              variant="ghost"
              size="xs"
              disabled={retry.isPending}
              onClick={() => retry.mutate()}
            >
              Run again
            </Button>
          ) : null
        }
      >
        <ul className="space-y-2 text-sm">
          {view.research.map((row) => (
            <li key={row.kind} className="space-y-0.5">
              <div className="flex items-center justify-between gap-2">
                <span className="font-medium">
                  {row.kind === "BRIEF"
                    ? "Account brief"
                    : row.kind.toLowerCase()}
                </span>
                <span className="text-xs text-muted-foreground tabular-nums">
                  {row.status.toLowerCase().replace("_", " ")} ·{" "}
                  {usd(row.costUsd)}
                  {row.filledByApp ? ` · via ${row.filledByApp}` : ""}
                </span>
              </div>
              {row.summary ? (
                <p className="text-muted-foreground">{row.summary}</p>
              ) : null}
              {row.status === "PENDING" && row.error ? (
                <p className="text-xs text-muted-foreground">{row.error}</p>
              ) : null}
            </li>
          ))}
        </ul>
        {briefSections.length ? (
          <dl className="space-y-1 rounded-md bg-muted/50 p-3">
            {briefSections.map(([name, value]) => (
              <Row
                key={name}
                label={BRIEF_LABELS[name] ?? name}
                value={value}
              />
            ))}
          </dl>
        ) : null}
      </SheetSection>

      {view.conversions.length || view.asana ? (
        <SheetSection title="After the call">
          <dl className="space-y-1">
            {view.conversions.map((row) => (
              <Row
                key={`${row.platform}:${row.event}`}
                label={`${row.platform.toLowerCase()} · ${row.event.toLowerCase().replace("_", " ")}`}
                value={row.status.toLowerCase().replace("_", " ")}
              />
            ))}
            {view.asana ? (
              <Row
                label="Asana"
                value={
                  view.asana.taskUrl ? (
                    <a
                      href={view.asana.taskUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="underline"
                    >
                      Intake task
                    </a>
                  ) : (
                    (view.asana.error ?? "handing off")
                  )
                }
              />
            ) : null}
          </dl>
        </SheetSection>
      ) : null}
    </>
  );
}
