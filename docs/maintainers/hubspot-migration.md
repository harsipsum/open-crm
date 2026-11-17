# HubSpot migration and Won handoff

The importer copies source records into the CRM and preserves the full source
properties in `hubspot_object.data`, keyed by organization, portal, type and ID.
`hubspot_association` preserves every direction and label, including secondary
relationships. Owners are inert user mirrors, never gateway accounts or invites.
Companies without a domain and contacts without an email remain separate rows.
When source companies share a domain, only one native row claims that domain;
every original domain remains in its source properties. A system placeholder
holds deals with no associated company without inventing a source company.

Configure a random `HUBSPOT_IMPORT_KEY` in the app's secrets. The destination must
be pinned to its gateway organization. Run the script with secrets supplied as
environment variables inside a command, never in arguments or committed files:

```sh
node scripts/import-hubspot.ts
```

Inputs: `HUBSPOT_TOKEN`, `HUBSPOT_PORTAL_ID`, `STAR_CRM_URL`, `STAR_CRM_KEY`.
The script accepts any HTTPS Star CRM base URL, so the same import can populate
a new client-owned install. Use `HUBSPOT_IMPORT_PHASE=objects` or `associations`
to recover one phase; the default `all` verifies both. `HUBSPOT_IMPORT_FROM=deals` resumes writes at deals while still
reading earlier IDs and verifying all final counts. Archived records use
full-property list pages because HubSpot can omit listed archived IDs from
batch/read and even return 404 from their individual reads. Source CRM access is
strictly read-only. The only POSTs to HubSpot are batch/read and search.
Archived source records are included separately from active API totals. Their
destination retention clock starts on import; original dates stay in the blob.

The script prints counts only. It stores no source records on disk. The
durable `.everyapp/hubspot-api-budget.json` counts every attempted call before
it is sent, across replays. The migration stops at 10,000 calls per UTC day,
at 1,000 calls of reported daily headroom, or after six rate-limit retries.
Requests are paced below Starter's burst limit. Keep the same budget file
across runs. An early stop preserves all committed batches; a replay upserts
the same IDs. Remove the import key after reconciliation.

Imports call repositories directly and never use intake or stage services.
They hold research, create no SDR timers or conversion events, and never queue
Asana work. `asana_won_queue` is inserted atomically only when a normal stage
move wins its compare-and-swap into `CLOSED_WON` while the delivery flag is on.
Historical wins and transitions while disabled have no entry.

`ASANA_WON_ENABLED=1` is the single delivery switch. Leave it `0` until the
HubSpot flow is disabled at cutover. The switch disables cron sends, direct
handoffs and retries. Configure `ASANA_TOKEN`, `ASANA_PROJECT_GID` and
`VIS_CRM_ORIGIN` before enabling. A cron processes at most ten queued deals
per tick and one hundred attempts per day. Its log reports when the cap stops
delivery, and pending work remains queued. The task includes company, contact
name, email, phone, deal value and CRM link. Custom intake fields are matched by
name; unavailable fields are written as labelled task-description lines.

Each deal gets one claim before any Asana request. Failed handoffs do not retry
on cron. An ambiguous task-creation result is marked `RECONCILE_REQUIRED` and
cannot be retried until an operator reconciles Asana. The live daily check is
the queue count and the task receipt on a fresh Won transition, after cutover.
For a proof, use one synthetic deal and a private test project, read the task
back, then archive the synthetic deal and remove the test task. Restore the
production project and switch the flag off before leaving the run.
