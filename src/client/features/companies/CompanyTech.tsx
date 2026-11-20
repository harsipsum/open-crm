import { useState } from "react";
import {
  queryOptions,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { Plus } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/client/components/ui/badge";
import { Button } from "@/client/components/ui/button";
import { Input } from "@/client/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/client/components/ui/select";
import { companyKeys } from "@/client/features/companies/companyQueries";
import { LocalDay } from "@/client/features/records/LocalDateTime";
import { SheetSection } from "@/client/features/records/RecordSheet";
import { workspaceQueryOptions } from "@/client/features/workspace/workspaceQueries";
import { getStandardErrorMessage } from "@/client/lib/error-messages";
import type { CompanyTechLine } from "@/server/features/tech/services/CompanyTechService";
import {
  addCompanyTech,
  archiveCompanyTech,
  confirmCompanyTech,
  listCompanyTech,
} from "@/serverFunctions/companyTech";
import {
  TECH_CATEGORIES,
  TECH_CATEGORY_LABELS,
  type TechCategory,
} from "@/shared/tech";

// The systems a company runs. Each line says whether the team verified it
// and where it came from, so nobody mistakes a guess from a public page for
// something a customer told us.

const techQueryOptions = (companyId: string) =>
  queryOptions({
    queryKey: [...companyKeys.detail(companyId), "tech"],
    queryFn: () => listCompanyTech({ data: { companyId } }),
  });

const NO_CATEGORY = "NONE";
type CategoryChoice = TechCategory | typeof NO_CATEGORY;
const CATEGORY_ITEMS: { value: CategoryChoice; label: string }[] = [
  { value: NO_CATEGORY, label: "No category" },
  ...TECH_CATEGORIES.map((value) => ({
    value,
    label: TECH_CATEGORY_LABELS[value],
  })),
];

function useTechMutations(companyId: string) {
  const queryClient = useQueryClient();
  const refresh = () =>
    queryClient.invalidateQueries({
      queryKey: techQueryOptions(companyId).queryKey,
    });
  const onError = (error: unknown) =>
    toast.error(getStandardErrorMessage(error));
  return {
    add: useMutation({
      mutationFn: (input: { product: string; category?: TechCategory }) =>
        addCompanyTech({ data: { companyId, origin: "team", ...input } }),
      onSuccess: async (line) => {
        toast.success(
          line.created
            ? `${line.product} added.`
            : `${line.product} was already listed. It is now verified.`,
        );
        await refresh();
      },
      onError,
    }),
    confirm: useMutation({
      mutationFn: (id: string) => confirmCompanyTech({ data: { id } }),
      onSuccess: async (line) => {
        toast.success(`${line.product} verified.`);
        await refresh();
      },
      onError,
    }),
    archive: useMutation({
      mutationFn: (id: string) => archiveCompanyTech({ data: { id } }),
      onSuccess: async (line) => {
        toast.success(`${line.product} archived.`);
        await refresh();
      },
      onError,
    }),
  };
}

/** Where a line came from, in words. */
function OriginLine({
  line,
  workspaceName,
}: {
  line: CompanyTechLine;
  workspaceName: string;
}) {
  const day = line.observedAt ?? line.createdAt;
  if (line.origin === "team") {
    return (
      <>
        Entered by {line.enteredByName ?? "a former member"},{" "}
        <LocalDay date={day} />
      </>
    );
  }
  const from =
    line.origin === "email" ? (
      <>From {workspaceName} email</>
    ) : line.publicUrl && line.publicHost ? (
      <>
        Public:{" "}
        <a
          href={line.publicUrl}
          target="_blank"
          rel="noreferrer"
          className="underline-offset-4 hover:underline"
        >
          {line.publicHost}
        </a>
      </>
    ) : (
      <>Public info</>
    );
  return (
    <>
      {from}, <LocalDay date={day} />
      {line.verified && line.confirmedByName ? (
        <>. Confirmed by {line.confirmedByName}</>
      ) : null}
    </>
  );
}

function AddTech({
  companyId,
  onDone,
}: {
  companyId: string;
  onDone: () => void;
}) {
  const { add } = useTechMutations(companyId);
  const [product, setProduct] = useState("");
  const [category, setCategory] = useState<CategoryChoice>(NO_CATEGORY);
  const submit = () => {
    const name = product.trim();
    if (!name) return;
    add.mutate(
      {
        product: name,
        ...(category === NO_CATEGORY ? {} : { category }),
      },
      { onSuccess: onDone },
    );
  };
  return (
    <form
      className="mb-3 space-y-3 rounded-lg border border-border p-3"
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      <div className="grid gap-3 sm:grid-cols-2">
        <Input
          aria-label="Product"
          placeholder="Product, like Zoho Books"
          value={product}
          maxLength={120}
          autoFocus
          onChange={(event) => setProduct(event.target.value)}
        />
        <Select
          items={CATEGORY_ITEMS}
          value={category}
          onValueChange={(value) => {
            if (value) setCategory(value);
          }}
        >
          <SelectTrigger aria-label="Category" className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {CATEGORY_ITEMS.map((item) => (
              <SelectItem key={item.value} value={item.value}>
                {item.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <p className="text-xs text-muted-foreground">
        What you enter is marked Verified, as entered by you.
      </p>
      <div className="flex justify-end gap-2">
        <Button type="button" variant="ghost" size="sm" onClick={onDone}>
          Cancel
        </Button>
        <Button
          type="submit"
          size="sm"
          disabled={!product.trim() || add.isPending}
        >
          Add
        </Button>
      </div>
    </form>
  );
}

/** A company's Tech Stack section: its systems, verified or not, and where each came from. */
export function CompanyTech({
  companyId,
  archived,
}: {
  companyId: string;
  archived: boolean;
}) {
  const query = useQuery(techQueryOptions(companyId));
  const workspace = useQuery(workspaceQueryOptions());
  const { confirm, archive } = useTechMutations(companyId);
  const [adding, setAdding] = useState(false);
  const lines = query.data ?? [];
  const workspaceName = workspace.data?.name ?? "team";
  return (
    <SheetSection
      title={`Tech stack (${lines.length})`}
      action={
        adding || archived ? null : (
          <Button variant="ghost" size="xs" onClick={() => setAdding(true)}>
            <Plus data-icon="inline-start" />
            Add
          </Button>
        )
      }
    >
      {adding ? (
        <AddTech companyId={companyId} onDone={() => setAdding(false)} />
      ) : null}
      {query.isError ? (
        <p className="text-sm text-muted-foreground">
          The tech stack could not be loaded.
        </p>
      ) : lines.length === 0 && !query.isPending ? (
        <p className="text-sm text-muted-foreground">
          No systems yet. Add what this company runs: its ERP, CRM, accounting
          or ITSM.
        </p>
      ) : (
        <ul className="-mx-2 divide-y divide-border" data-testid="tech-stack">
          {lines.map((line) => (
            <li
              key={line.id}
              className="flex min-w-0 flex-wrap items-center gap-x-2.5 gap-y-1 px-2 py-2"
            >
              <div className="min-w-0 flex-1 basis-48">
                <div className="flex flex-wrap items-center gap-1.5">
                  <span className="text-sm font-medium">{line.product}</span>
                  {line.category ? (
                    <Badge variant="outline" size="sm">
                      {TECH_CATEGORY_LABELS[line.category]}
                    </Badge>
                  ) : null}
                  <Badge
                    variant={line.verified ? "success" : "warning"}
                    size="sm"
                  >
                    {line.verified ? "Verified" : "Unverified"}
                  </Badge>
                </div>
                <p className="text-xs text-muted-foreground">
                  <OriginLine line={line} workspaceName={workspaceName} />
                </p>
              </div>
              {archived ? null : (
                <div className="flex items-center gap-1">
                  {line.verified ? null : (
                    <Button
                      variant="outline"
                      size="xs"
                      disabled={confirm.isPending}
                      onClick={() => confirm.mutate(line.id)}
                    >
                      Confirm
                    </Button>
                  )}
                  <Button
                    variant="ghost"
                    size="xs"
                    aria-label={`Archive ${line.product}`}
                    disabled={archive.isPending}
                    onClick={() => archive.mutate(line.id)}
                  >
                    Archive
                  </Button>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </SheetSection>
  );
}
