/**
 * OpenCRM on an Every App gateway. The gateway signs people in and decides
 * who may open the CRM, serves its tools on the gateway's one MCP connector,
 * and holds each member's Google and Microsoft connections for mail capture,
 * so a deploy needs no settings of its own. Everything it can be given is an
 * optional feature (`features`, below), with its setup steps: `everyapp
 * configure crm` walks them, and the gateway and `everyapp status` show each
 * one's state. See docs/maintainers/every-app.md.
 *
 *   pnpm deploy:everyapp   # D1, pinned to the organization (EVERY_APP_ORG_ID)
 *   pnpm dev               # everyapp dev: D1, behind a gateway-lite
 */
export default {
  id: "crm",
  name: "OpenCRM",
  description:
    "Companies, contacts and deals, with mail, meetings and website visits filed on them.",
  icon: "/everyapp-icon.svg",
  resources: {
    d1: ["DB"],
  },
  migrations: {
    engine: "drizzle" as const,
    dir: "drizzle/sqlite",
    config: "drizzle/sqlite.config.ts",
    binding: "DB",
  },
  // What the CRM calls with a key only the gateway holds (integrationFetch).
  // The gateway attributes each call to the organization in the request's
  // identity, or, from the cron, in `x-everyapp-org`
  // (src/server/lib/gateway-attribution.ts). Mail and calendar are features
  // whose connect pages say what is missing until the gateway holds their
  // client.
  capabilities: {
    // Each member connects their own mailbox in Settings → Connections; the
    // gateway runs the OAuth flow, holds the connection and puts its token on
    // the CRM's calls (src/server/features/mailbox/providers/gateway.ts). The
    // scopes are the provider's own; the gateway adds the sign-in ones and
    // refuses a token carrying more.
    "google-workspace": {
      scopes: ["gmail.readonly", "calendar.readonly"],
      why: "Members connect their Gmail and Google Calendar, read only, so their work conversations and meetings are filed on companies and contacts.",
    },
    "microsoft-365": {
      scopes: [
        "https://graph.microsoft.com/User.Read",
        "https://graph.microsoft.com/Mail.Read",
      ],
      why: "Members connect their Outlook mail, read only, so their work conversations are filed on companies and contacts.",
    },
  },
  // Optional, each all or nothing: the CRM opens without any of them, and
  // the feature that needs one says so where it is used.
  features: {
    google: {
      name: "Gmail and Google Calendar",
      why: "Members connect their Gmail and Google Calendar, read only, so conversations and meetings are filed on companies and contacts.",
      steps: [
        "In the Google Cloud console, enable the Gmail API and the Google Calendar API: https://console.cloud.google.com/apis/library",
        "Create an OAuth client of type Web application: https://console.cloud.google.com/apis/credentials",
        "Redirect URI: {gatewayUrl}/connect/google-workspace/callback. Consent screen scopes: gmail.readonly and calendar.readonly.",
      ],
      capabilities: ["google-workspace"],
    },
    microsoft: {
      name: "Outlook",
      why: "Members connect their Outlook mail, read only, so conversations are filed on companies and contacts.",
      steps: [
        "Register an application for accounts in any organizational directory and personal Microsoft accounts: https://entra.microsoft.com/#view/Microsoft_AAD_RegisteredApps/ApplicationsListBlade",
        "Web redirect URI: {gatewayUrl}/connect/microsoft-365/callback. Delegated Microsoft Graph permissions: User.Read, Mail.Read and offline_access.",
        "Create a client secret. It expires after the period you pick; set a new one before it does.",
      ],
      capabilities: ["microsoft-365"],
    },
    // docs/maintainers/runbooks/erase-organization.md
    erasure: {
      name: "Organization erasure",
      why: "Set only while an operator erases an organization: it signs the erasure requests. Unset it afterwards.",
      steps: [
        "Follow the runbook: https://github.com/every-app/open-crm/blob/main/docs/maintainers/runbooks/erase-organization.md",
      ],
      secrets: [
        {
          name: "ERASURE_SECRET",
          how: "A long random value, e.g. openssl rand -base64 32; the erasure script signs with the same value.",
        },
      ],
    },
    // VisCRM (src/server/features/vis): each optional; without one, its
    // step waits and the deal's Lead section says so.
    "vis-research": {
      name: "Lead research",
      why: "Composio Instant: company at intake, person at Qualified.",
      steps: ["Composio API key; turn on Instant Toolkits in the project."],
      secrets: [{ name: "COMPOSIO_API_KEY", how: "Composio project key." }],
    },
    "vis-asana": {
      name: "Won deals to Asana",
      why: "A won deal becomes an intake task with every field filled.",
      steps: ["A service identity's Asana token and the intake project id."],
      secrets: [
        { name: "ASANA_TOKEN", how: "Service identity token." },
        { name: "ASANA_PROJECT_GID", how: "Intake project id." },
        { name: "VIS_CRM_ORIGIN", how: "This CRM's https origin." },
      ],
    },
    "vis-conversions": {
      name: "Offline conversions",
      why: "Qualified and won deals to Google, Meta and LinkedIn; dry run unless VIS_CONVERSIONS_LIVE is 1.",
      steps: ["Each platform's keys; unset ones stay dry runs."],
      secrets: [
        { name: "VIS_CONVERSIONS_LIVE", how: "1 sends." },
        { name: "GOOGLE_DATA_MANAGER_TOKEN", how: "Data Manager token." },
        { name: "GOOGLE_ADS_CUSTOMER_ID", how: "Customer id." },
        { name: "GOOGLE_ADS_QUALIFIED_ACTION_ID", how: "Action id." },
        { name: "GOOGLE_ADS_PURCHASE_ACTION_ID", how: "Action id." },
        { name: "META_DATASET_ID", how: "Dataset id." },
        { name: "META_CAPI_TOKEN", how: "CAPI token." },
        { name: "META_WABA_ID", how: "WhatsApp Business Account id." },
        { name: "LINKEDIN_CAPI_TOKEN", how: "Conversions token." },
        { name: "LINKEDIN_QUALIFIED_CONVERSION_URN", how: "Conversion URN." },
        { name: "LINKEDIN_PURCHASE_CONVERSION_URN", how: "Conversion URN." },
      ],
    },
  },
  // Every member of the organization works in the CRM.
  access: "everyone",
  // Nothing reaches the CRM without a signed-in member but website tracking,
  // which runs on the organization's own website for anonymous visitors
  // (docs/maintainers/website-tracking.md): the loader and per-site tracker
  // scripts, and the collector they POST to. The tracker never sends a
  // preflight (a text/plain beacon), so OPTIONS stays private. The gateway's
  // tool calls (`/__everyapp/tools/*`) carry their own gateway-signed tokens.
  // /health is not here: a signed-in member or a personal access token reaches
  // it, and the gateway's own https://<gateway>/health is the public liveness
  // check.
  public: [
    { path: "/t/*", methods: ["GET"] },
    { path: "/t/e", methods: ["POST"] },
    // An operator erasing an organization, with requests signed by
    // ERASURE_SECRET; 404 while it is unset (src/server/features/erasure).
    { path: "/internal/erase-organization", methods: ["POST"] },
    // VisCRM's write API for the sibling apps; every call carries its app's
    // key, which names the organization (src/server/features/vis/visApiRoute.ts).
    { path: "/api/vis/**", methods: ["GET", "POST"] },
  ],
} as const;
