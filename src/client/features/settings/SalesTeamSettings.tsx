import {
  queryOptions,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { useState } from "react";
import { toast } from "sonner";
import {
  SettingsCard,
  SettingsSection,
} from "@/client/components/SettingsSection";
import { Button } from "@/client/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/client/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/client/components/ui/select";
import { getTeam, setMemberLeft, setMemberRole } from "@/serverFunctions/team";
import { CRM_ROLES, type CrmRole } from "@/shared/crm-roles";

// Who sees what. Admins see every record, managers their team's, sellers
// their own; everyone sees the shared pool. Marking someone as left puts
// their book in the shared pool at once, or hands it to one person.

export const teamQueryOptions = () =>
  queryOptions({ queryKey: ["team"], queryFn: () => getTeam() });

type TeamRow = Awaited<ReturnType<typeof getTeam>>[number];

const ROLE_LABELS: Record<CrmRole, string> = {
  admin: "Admin",
  manager: "Manager",
  seller: "Seller",
};
const ROLE_ITEMS = CRM_ROLES.map((role) => ({
  value: role,
  label: ROLE_LABELS[role],
}));
const NO_MANAGER = "none";
const SHARED = "shared";

export function SalesTeamSettings() {
  const queryClient = useQueryClient();
  const team = useQuery(teamQueryOptions());
  const [leaving, setLeaving] = useState<TeamRow | null>(null);

  // Visibility changed: every list and record may show something else.
  const refresh = () => queryClient.invalidateQueries();
  const role = useMutation({
    mutationFn: (input: {
      userId: string;
      role: CrmRole;
      managerId: string | null;
    }) => setMemberRole({ data: input }),
    onSuccess: refresh,
    onError: (error) => toast.error(error.message),
  });
  const back = useMutation({
    mutationFn: (userId: string) =>
      setMemberLeft({ data: { userId, left: false, handTo: null } }),
    onSuccess: refresh,
    onError: (error) => toast.error(error.message),
  });

  const rows = team.data ?? [];
  const managers = rows.filter((row) => row.role !== "seller" && !row.leftAt);

  return (
    <SettingsSection
      id="sales-team"
      title="Sales team"
      description="Admins see every record, managers see their team's, sellers see their own. Everyone sees the shared pool."
    >
      <SettingsCard>
        {rows.map((row) => (
          <div
            key={row.userId}
            className="flex flex-col gap-3 px-4 py-3 sm:flex-row sm:items-center"
          >
            <span
              className={
                row.leftAt
                  ? "min-w-0 flex-1 truncate text-sm text-muted-foreground line-through"
                  : "min-w-0 flex-1 truncate text-sm font-medium"
              }
            >
              {row.name}
            </span>
            <div className="flex flex-wrap items-center gap-2">
              <Select
                items={ROLE_ITEMS}
                value={row.role}
                disabled={row.fixedAdmin || !!row.leftAt || role.isPending}
                onValueChange={(value) => {
                  if (!value || value === row.role) return;
                  role.mutate({
                    userId: row.userId,
                    role: value,
                    managerId: value === "seller" ? row.managerId : null,
                  });
                }}
              >
                <SelectTrigger
                  aria-label={`Role of ${row.name}`}
                  className="w-32"
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {ROLE_ITEMS.map((item) => (
                    <SelectItem key={item.value} value={item.value}>
                      {item.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {row.role === "seller" && !row.leftAt ? (
                <ManagerSelect
                  row={row}
                  managers={managers}
                  disabled={role.isPending}
                  onChange={(managerId) =>
                    role.mutate({
                      userId: row.userId,
                      role: row.role,
                      managerId,
                    })
                  }
                />
              ) : null}
              {row.fixedAdmin ? null : row.leftAt ? (
                <Button
                  variant="outline"
                  size="sm"
                  disabled={back.isPending}
                  onClick={() => back.mutate(row.userId)}
                >
                  Bring back
                </Button>
              ) : (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setLeaving(row)}
                >
                  Mark as left
                </Button>
              )}
            </div>
          </div>
        ))}
      </SettingsCard>
      {leaving ? (
        <LeaverDialog
          leaver={leaving}
          heirs={rows.filter(
            (row) => !row.leftAt && row.userId !== leaving.userId,
          )}
          onClose={() => setLeaving(null)}
          onDone={refresh}
        />
      ) : null}
    </SettingsSection>
  );
}

function ManagerSelect({
  row,
  managers,
  disabled,
  onChange,
}: {
  row: TeamRow;
  managers: TeamRow[];
  disabled: boolean;
  onChange: (managerId: string | null) => void;
}) {
  const items = [
    { value: NO_MANAGER, label: "No manager" },
    ...managers.map((manager) => ({
      value: manager.userId,
      label: manager.name,
    })),
  ];
  return (
    <Select
      items={items}
      value={row.managerId ?? NO_MANAGER}
      disabled={disabled}
      onValueChange={(value) => {
        if (!value) return;
        const next = value === NO_MANAGER ? null : value;
        if (next !== row.managerId) onChange(next);
      }}
    >
      <SelectTrigger aria-label={`Manager of ${row.name}`} className="w-40">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {items.map((item) => (
          <SelectItem key={item.value} value={item.value}>
            {item.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

/** The leaver handover: one step, and nothing they owned goes dark. */
function LeaverDialog({
  leaver,
  heirs,
  onClose,
  onDone,
}: {
  leaver: TeamRow;
  heirs: TeamRow[];
  onClose: () => void;
  onDone: () => Promise<void>;
}) {
  const [handTo, setHandTo] = useState(SHARED);
  const items = [
    { value: SHARED, label: "The shared pool" },
    ...heirs.map((heir) => ({ value: heir.userId, label: heir.name })),
  ];
  const mutation = useMutation({
    mutationFn: () =>
      setMemberLeft({
        data: {
          userId: leaver.userId,
          left: true,
          handTo: handTo === SHARED ? null : handTo,
        },
      }),
    onSuccess: async ({ moved }) => {
      await onDone();
      toast.success(
        handTo === SHARED
          ? `Records of ${leaver.name} are in the shared pool.`
          : `Handed over ${moved.deals} open deals, ${moved.contacts} contacts and ${moved.tasks} open tasks.`,
      );
      onClose();
    },
    onError: (error) => toast.error(error.message),
  });
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !mutation.isPending) onClose();
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{leaver.name} left</DialogTitle>
          <DialogDescription>
            Their open deals and contacts go to one person, or into the shared
            pool where any seller can take them over.
          </DialogDescription>
        </DialogHeader>
        <Select
          items={items}
          value={handTo}
          onValueChange={(value) => {
            if (value) setHandTo(value);
          }}
        >
          <SelectTrigger aria-label="Hand their records to" className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {items.map((item) => (
              <SelectItem key={item.value} value={item.value}>
                {item.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <DialogFooter>
          <Button
            variant="outline"
            disabled={mutation.isPending}
            onClick={onClose}
          >
            Cancel
          </Button>
          <Button
            disabled={mutation.isPending}
            onClick={() => mutation.mutate()}
          >
            Hand over
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
