// The CRM's own roles, on top of the gateway's sign-in. Admins see and
// change everything; managers see their team's records; sellers see their
// own. Everyone also sees the shared pool: records with no owner, or owned
// by someone who is not a working member (a leaver, a HubSpot-era owner).
export const CRM_ROLES = ["admin", "manager", "seller"] as const;
export type CrmRole = (typeof CRM_ROLES)[number];

/** Exports are for managers and admins. */
export function canExport(role: CrmRole) {
  return role === "admin" || role === "manager";
}

/** Giving a record to someone else, and setting roles, is for managers and admins. */
export function canAssignOthers(role: CrmRole) {
  return role === "admin" || role === "manager";
}
