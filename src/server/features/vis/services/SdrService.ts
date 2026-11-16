import { AuthRepository } from "@/server/auth/repositories/AuthRepository";
import { ActivityRepository } from "@/server/features/activities/repositories/ActivityRepository";
import { DealService } from "@/server/features/deals/services/DealService";
import { VisWorkRepository } from "@/server/features/vis/repositories/VisWorkRepository";
import { AppError } from "@/server/lib/errors";
import { SDR_CALL_MINUTES, SDR_ESCALATE_HOURS } from "@/shared/vis";

// The SDR's first call on an inbound lead (Vistar's SLA: call within 5
// minutes; nobody called in 24 hours escalates). The call is an ordinary CRM
// task on the owner's task list, due in 5 minutes; ticking it off closes the
// timer. The tick escalates what's still open at 24 hours: the timer is
// marked once, a task goes to an owner or admin who isn't the deal's owner,
// and a note says so on the deal.

const MINUTE = 60_000;

async function startFirstCall(
  organizationId: string,
  input: {
    dealId: string;
    contactId: string;
    ownerId: string;
    createdAt: string;
  },
) {
  const created = Date.parse(input.createdAt);
  const dueAt = new Date(created + SDR_CALL_MINUTES * MINUTE).toISOString();
  const escalateAt = new Date(
    created + SDR_ESCALATE_HOURS * 60 * MINUTE,
  ).toISOString();
  const found = await DealService.getDeal(organizationId, input.dealId);
  const taskId = await ActivityRepository.insert({
    organizationId,
    type: "TASK",
    subject: `Call ${found.name} within ${SDR_CALL_MINUTES} minutes`,
    body: "New inbound lead. Read the Research tab, then call.",
    occurredAt: input.createdAt,
    dueAt,
    companyId: found.company.id,
    contactId: input.contactId,
    dealId: input.dealId,
    createdById: input.ownerId,
  });
  await VisWorkRepository.insertTimer({
    id: crypto.randomUUID(),
    organizationId,
    dealId: input.dealId,
    taskActivityId: taskId,
    ownerId: input.ownerId,
    dueAt,
    escalateAt,
  });
  return { taskId, dueAt, escalateAt };
}

/** The SDR made the call: ticks the task off (the tick closes the timer). */
async function completeFirstCall(organizationId: string, dealId: string) {
  const found = await VisWorkRepository.timer(organizationId, dealId);
  if (!found?.taskActivityId) {
    throw new AppError("NOT_FOUND", "This deal has no first-call task.");
  }
  await ActivityRepository.setCompleted(
    organizationId,
    found.taskActivityId,
    new Date().toISOString(),
  );
  await VisWorkRepository.closeCompletedTimers(organizationId);
  return VisWorkRepository.timer(organizationId, dealId);
}

/** Whom an escalation goes to: an owner or admin who isn't the deal owner. */
async function escalationOwner(
  organizationId: string,
  dealOwnerId: string | null,
) {
  const members = await AuthRepository.listMembers(organizationId);
  const leads = members.filter(
    (member) => member.role === "owner" || member.role === "admin",
  );
  return (
    (
      leads.find((member) => member.userId !== dealOwnerId) ??
      leads[0] ??
      members[0] ??
      null
    )?.userId ?? null
  );
}

/** Closes ticked-off timers and escalates the ones 24 hours late. */
async function tick(organizationId: string, now: string) {
  const closed = await VisWorkRepository.closeCompletedTimers(organizationId);
  let escalated = 0;
  for (const late of await VisWorkRepository.timersToEscalate(
    organizationId,
    now,
  )) {
    const to = await escalationOwner(organizationId, late.ownerId);
    if (
      !(await VisWorkRepository.markEscalated(organizationId, late.id, to, now))
    ) {
      continue;
    }
    try {
      const found = await DealService.getDeal(organizationId, late.dealId);
      await ActivityRepository.insert({
        organizationId,
        type: "TASK",
        subject: `Escalated: nobody called ${found.name} in ${SDR_ESCALATE_HOURS} h`,
        body: `The first call was due ${late.dueAt}. Call now or reassign.`,
        occurredAt: now,
        dueAt: now,
        companyId: found.company.id,
        contactId: null,
        dealId: late.dealId,
        createdById: to,
      });
    } catch (error) {
      // No task, no escalation: the timer opens again for the next tick.
      await VisWorkRepository.reopenEscalation(organizationId, late.id);
      throw error;
    }
    escalated += 1;
    console.log("[vis] sdr escalated", {
      organizationId,
      dealId: late.dealId,
    });
  }
  return { closed, escalated };
}

export const SdrService = { startFirstCall, completeFirstCall, tick };
