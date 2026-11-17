import { useQuery } from "@tanstack/react-query";
import { UserRound } from "lucide-react";
import type { ListFilter } from "@/client/components/table/FiltersMenu";
import { membersQueryOptions } from "@/client/features/members/memberQueries";
import { InlineSelectField } from "@/client/features/records/InlineField";
import type { Owner } from "@/client/features/records/cells";
import { Button } from "@/client/components/ui/button";
import { workspaceQueryOptions } from "@/client/features/workspace/workspaceQueries";
import { canAssignOthers } from "@/shared/crm-roles";
import {
  OWNER_FILTER_MAX,
  SHARED_POOL,
  UNASSIGNED,
} from "@/types/schemas/records";

// Who owns a record: one of the organization's members, or nobody. The
// members are the people the gateway has let into the CRM so far.

type OwnerOption = { value: string; label: string };

/** "Unassigned" (or `noneLabel`), then each member by name. */
export function useOwnerOptions(noneLabel = "Unassigned"): OwnerOption[] {
  const members = useQuery(membersQueryOptions());
  return [
    { value: UNASSIGNED, label: noneLabel },
    ...(members.data ?? []).map((member) => ({
      value: member.userId,
      label: member.name,
    })),
  ];
}

/** The owner value a form or menu sends: null for nobody. */
export function ownerIdOf(value: string): string | null {
  return value === UNASSIGNED ? null : value;
}

/**
 * The owners the signed-in member may pick on a record: anyone for managers
 * and admins; themselves or nobody for sellers. The current owner stays in
 * the list either way, so the field still shows them.
 */
export function useAssignableOptions(
  current: Owner | null,
  noneLabel?: string,
): OwnerOption[] {
  const options = useOwnerOptions(noneLabel);
  const { data: workspace } = useQuery(workspaceQueryOptions());
  const mine =
    workspace && !canAssignOthers(workspace.crmRole)
      ? options.filter(
          (option) =>
            option.value === UNASSIGNED ||
            option.value === workspace.userId ||
            option.value === current?.id,
        )
      : options;
  return current && !mine.some((option) => option.value === current.id)
    ? [...mine, { value: current.id, label: current.name }]
    : mine;
}

/**
 * The signed-in member's id when this record sits in the shared pool (no
 * owner, or an owner who left), so they can take it over; otherwise null.
 */
export function useTakeOver(ownerId: string | null): string | null {
  const { data: workspace } = useQuery(workspaceQueryOptions());
  if (!workspace) return null;
  const shared = !ownerId || !workspace.workingOwnerIds.includes(ownerId);
  return shared ? workspace.userId : null;
}

/** "Take over" under a shared record's owner. */
export function TakeOverButton({
  me,
  saving,
  onTake,
}: {
  me: string | null;
  saving: boolean;
  onTake: (userId: string) => void;
}) {
  if (!me) return null;
  return (
    <div className="flex justify-end px-2">
      <Button
        variant="outline"
        size="sm"
        disabled={saving}
        onClick={() => onTake(me)}
      >
        Take over
      </Button>
    </div>
  );
}

/** A record sheet's owner, changed in place. */
export function OwnerField({
  owner,
  saving,
  onSave,
}: {
  owner: Owner | null;
  saving: boolean;
  onSave: (ownerId: string | null) => void;
}) {
  // Someone who left still owns their records until they're reassigned.
  const items = useAssignableOptions(owner);
  const me = useTakeOver(owner?.id ?? null);
  return (
    <>
      <InlineSelectField
        label="Owner"
        value={owner?.id ?? UNASSIGNED}
        items={items}
        saving={saving}
        onSave={(value) => onSave(ownerIdOf(value))}
      />
      <TakeOverButton me={me} saving={saving} onTake={onSave} />
    </>
  );
}

/** The lists' Owner filter: records any of the chosen owners own. */
export function useOwnerFilter(
  value: string[],
  onChange: (owners: string[]) => void,
  counts: Record<string, number> | undefined,
): ListFilter {
  const members = useOwnerOptions();
  // The shared pool: records whose owner left or never joined Star CRM.
  const options = [
    members[0],
    { value: SHARED_POOL, label: "Shared pool" },
    ...members.slice(1),
  ];
  return {
    key: "owner",
    label: "Owner",
    icon: UserRound,
    options,
    value,
    onChange,
    counts,
    max: OWNER_FILTER_MAX,
  };
}
