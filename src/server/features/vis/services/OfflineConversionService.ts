import type { VisRepository } from "@/server/features/vis/repositories/VisRepository";
import { VisWorkRepository } from "@/server/features/vis/repositories/VisWorkRepository";
import { getOptionalEnvValue } from "@/server/lib/runtime-env";
import {
  CONVERSION_PLATFORMS,
  type ConversionEventName,
  type ConversionPlatform,
  type ConversionStatus,
} from "@/shared/vis";

// The offline-conversion bus: when a tracked deal reaches Qualified, and
// again when it's won (with its value), the ad platform that brought it
// learns so, and its bidding learns from paid deals rather than form fills.
//
//   Google   Data Manager API events:ingest (required for new offline
//            conversion builds since 15 Jun 2026), matched on gclid, plus
//            the hashed email when consent was given
//   Meta     Conversions API, matched on fbclid (as fbc) or, for
//            click-to-WhatsApp, ctwa_clid with action_source
//            business_messaging; hashed email and phone with consent
//   LinkedIn Conversions API, matched on li_fat_id, hashed email with
//            consent
//
// Each event is built and recorded once per deal per platform, with the
// exact payload. It is sent only when VIS_CONVERSIONS_LIVE is "1" and that
// platform's credentials are set; otherwise it is kept as DRY_RUN, which is
// how it is tested on synthetic records. Consent DENIED sends nothing
// (SKIPPED); consent not given sends click ids only, never hashed contact
// details.

type Lead = NonNullable<Awaited<ReturnType<typeof VisRepository.attribution>>>;
type Person = { email: string | null; phone: string | null };

type ConversionInput = {
  dealId: string;
  event: ConversionEventName;
  stageName: string;
  at: string;
  value: number | null;
  currency: string | null;
  lead: Lead;
  person: Person | null;
};

async function sha256Hex(value: string) {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

async function hashedEmail(person: Person | null) {
  const email = person?.email?.trim().toLowerCase();
  return email ? sha256Hex(email) : null;
}

async function hashedPhone(person: Person | null) {
  const digits = person?.phone?.replace(/\D/g, "");
  return digits ? sha256Hex(digits) : null;
}

const META_EVENT: Record<ConversionEventName, string> = {
  QUALIFIED_LEAD: "Lead",
  PURCHASE: "Purchase",
};

/** The event as the platform takes it, and the click id it rides on. */
async function payloadFor(
  platform: ConversionPlatform,
  input: ConversionInput,
): Promise<{ clickId: string | null; body: Record<string, unknown> } | null> {
  const consented = input.lead.consent === "GRANTED";
  const email = consented ? await hashedEmail(input.person) : null;
  const phone = consented ? await hashedPhone(input.person) : null;
  const transactionId = `${input.dealId}:${input.event}`;
  const value =
    input.event === "PURCHASE" && input.value !== null
      ? { value: input.value, currency: input.currency ?? "USD" }
      : null;

  if (platform === "GOOGLE") {
    if (!input.lead.gclid && !email) return null;
    const actionId =
      input.event === "PURCHASE"
        ? await getOptionalEnvValue("GOOGLE_ADS_PURCHASE_ACTION_ID")
        : await getOptionalEnvValue("GOOGLE_ADS_QUALIFIED_ACTION_ID");
    return {
      clickId: input.lead.gclid,
      body: {
        destinations: [
          {
            operatingAccount: {
              accountType: "GOOGLE_ADS",
              accountId:
                (await getOptionalEnvValue("GOOGLE_ADS_CUSTOMER_ID")) ??
                "<customer id>",
            },
            productDestinationId: actionId ?? "<conversion action id>",
          },
        ],
        encoding: "HEX",
        consent: {
          adUserData: consented ? "CONSENT_GRANTED" : "CONSENT_DENIED",
          adPersonalization: consented ? "CONSENT_GRANTED" : "CONSENT_DENIED",
        },
        events: [
          {
            transactionId,
            eventTimestamp: input.at,
            eventSource: "OTHER",
            ...(input.lead.gclid
              ? { adIdentifiers: { gclid: input.lead.gclid } }
              : {}),
            ...(email
              ? { userData: { userIdentifiers: [{ emailAddress: email }] } }
              : {}),
            ...(value
              ? { conversionValue: value.value, currency: value.currency }
              : {}),
          },
        ],
      },
    };
  }

  if (platform === "META") {
    const viaWhatsApp = Boolean(input.lead.ctwaClid);
    if (!input.lead.fbclid && !viaWhatsApp && !email && !phone) return null;
    const userData: Record<string, unknown> = {};
    if (input.lead.fbclid) {
      userData.fbc = `fb.1.${Date.parse(input.lead.firstTouchAt)}.${input.lead.fbclid}`;
    }
    if (viaWhatsApp) {
      userData.ctwa_clid = input.lead.ctwaClid;
      const waba = await getOptionalEnvValue("META_WABA_ID");
      if (waba) userData.whatsapp_business_account_id = waba;
    }
    if (email) userData.em = [email];
    if (phone) userData.ph = [phone];
    return {
      clickId: input.lead.fbclid ?? input.lead.ctwaClid,
      body: {
        data: [
          {
            event_name: META_EVENT[input.event],
            event_time: Math.floor(Date.parse(input.at) / 1000),
            event_id: transactionId,
            action_source: viaWhatsApp
              ? "business_messaging"
              : "system_generated",
            ...(viaWhatsApp ? { messaging_channel: "whatsapp" } : {}),
            user_data: userData,
            custom_data: {
              lead_event_source: "VisCRM",
              ...(value
                ? { value: value.value, currency: value.currency }
                : {}),
            },
          },
        ],
      },
    };
  }

  if (!input.lead.liFatId && !email) return null;
  const urn =
    input.event === "PURCHASE"
      ? await getOptionalEnvValue("LINKEDIN_PURCHASE_CONVERSION_URN")
      : await getOptionalEnvValue("LINKEDIN_QUALIFIED_CONVERSION_URN");
  const userIds: { idType: string; idValue: string }[] = [];
  if (email) userIds.push({ idType: "SHA256_EMAIL", idValue: email });
  if (input.lead.liFatId) {
    userIds.push({
      idType: "LINKEDIN_FIRST_PARTY_ADS_TRACKING_UUID",
      idValue: input.lead.liFatId,
    });
  }
  return {
    clickId: input.lead.liFatId,
    body: {
      conversion: urn ?? "urn:lla:llaPartnerConversion:<id>",
      conversionHappenedAt: Date.parse(input.at),
      eventId: transactionId,
      user: { userIds },
      ...(value
        ? {
            conversionValue: {
              currencyCode: value.currency,
              amount: value.value.toFixed(2),
            },
          }
        : {}),
    },
  };
}

/** Where and how each platform takes the event, when its keys are set. */
async function endpointFor(
  platform: ConversionPlatform,
): Promise<{ url: string; headers: Record<string, string> } | null> {
  if (platform === "GOOGLE") {
    const token = await getOptionalEnvValue("GOOGLE_DATA_MANAGER_TOKEN");
    return token
      ? {
          url: "https://datamanager.googleapis.com/v1/events:ingest",
          headers: { authorization: `Bearer ${token}` },
        }
      : null;
  }
  if (platform === "META") {
    const pixel = await getOptionalEnvValue("META_DATASET_ID");
    const token = await getOptionalEnvValue("META_CAPI_TOKEN");
    return pixel && token
      ? {
          url: `https://graph.facebook.com/v25.0/${pixel}/events`,
          headers: { authorization: `Bearer ${token}` },
        }
      : null;
  }
  const token = await getOptionalEnvValue("LINKEDIN_CAPI_TOKEN");
  return token
    ? {
        url: "https://api.linkedin.com/rest/conversionEvents",
        headers: {
          authorization: `Bearer ${token}`,
          "linkedin-version": "202510",
          "x-restli-protocol-version": "2.0.0",
        },
      }
    : null;
}

async function deliver(
  platform: ConversionPlatform,
  body: Record<string, unknown>,
): Promise<{ status: ConversionStatus; response: string | null }> {
  const live = (await getOptionalEnvValue("VIS_CONVERSIONS_LIVE")) === "1";
  const endpoint = live ? await endpointFor(platform) : null;
  if (!endpoint) return { status: "DRY_RUN", response: null };
  try {
    const response = await fetch(endpoint.url, {
      method: "POST",
      headers: { "content-type": "application/json", ...endpoint.headers },
      body: JSON.stringify(body),
    });
    const text = (await response.text()).slice(0, 1000);
    return { status: response.ok ? "SENT" : "FAILED", response: text };
  } catch (error) {
    // Recorded, not thrown: the next tick doesn't send it again, and the
    // deal's other platforms and its handoff still run.
    return {
      status: "FAILED",
      response: error instanceof Error ? error.name : "network error",
    };
  }
}

/**
 * Records (and, when live, sends) the event on every platform, once each.
 * The event is claimed (PENDING) before anything is sent, so two ticks can't
 * both send it; one left PENDING by a Worker that stopped mid-send is shown
 * as such and never sent again by itself.
 */
async function emit(organizationId: string, input: ConversionInput) {
  let recorded = 0;
  for (const platform of CONVERSION_PLATFORMS) {
    const built =
      input.lead.consent === "DENIED"
        ? null
        : await payloadFor(platform, input);
    const claimed = await VisWorkRepository.insertConversion({
      organizationId,
      dealId: input.dealId,
      platform,
      event: input.event,
      stageName: input.stageName,
      value: input.event === "PURCHASE" ? input.value : null,
      currency: input.event === "PURCHASE" ? input.currency : null,
      clickId: built?.clickId ?? null,
      status: built ? "PENDING" : "SKIPPED",
      payload: built?.body ?? {
        skipped:
          input.lead.consent === "DENIED"
            ? "Consent denied"
            : `No ${platform.toLowerCase()} click id or consented identifier`,
      },
      response: null,
    });
    if (!claimed) continue;
    recorded += 1;
    if (!built) continue;
    const outcome = await deliver(platform, built.body);
    await VisWorkRepository.finishConversion(
      organizationId,
      input.dealId,
      platform,
      input.event,
      outcome,
    );
  }
  return recorded;
}

export const OfflineConversionService = { emit };
