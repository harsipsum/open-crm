import { VisKeyRepository } from "@/server/features/vis/repositories/VisKeyRepository";
import { AppError } from "@/server/lib/errors";
import { APP_SCOPES, type VisApp, type VisScope } from "@/shared/vis";

// One write key per sibling app (Hamza, 14 Nov: the CRM is the single
// source of truth; each app writes into it with its own key). The key is
// shown once when it is minted; the CRM keeps only its SHA-256, so a leaked
// database row can't be used to write. Minting a new key for an app revokes
// its old one in the same call.

const KEY_BYTES = 32;

function base64Url(bytes: Uint8Array) {
  return btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
}

async function sha256Hex(value: string) {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

/** Mints `app`'s key (revoking any live one) and returns it, once. */
async function mint(
  organizationId: string,
  app: VisApp,
  createdById: string | null,
) {
  const secret = `vck_${app.toLowerCase()}_${base64Url(crypto.getRandomValues(new Uint8Array(KEY_BYTES)))}`;
  const now = new Date().toISOString();
  await VisKeyRepository.rotateKey(
    {
      id: crypto.randomUUID(),
      organizationId,
      app,
      label: `${app} write key`,
      keyHash: await sha256Hex(secret),
      keyPrefix: secret.slice(0, 16),
      createdById,
    },
    now,
  );
  console.log("[vis] app key minted", { organizationId, app });
  return { app, key: secret, scopes: [...APP_SCOPES[app]] };
}

async function revoke(organizationId: string, app: VisApp) {
  const revoked = await VisKeyRepository.revokeKey(
    organizationId,
    app,
    new Date().toISOString(),
  );
  console.log("[vis] app key revoked", { organizationId, app, revoked });
  return { app, revoked };
}

function list(organizationId: string) {
  return VisKeyRepository.listKeys(organizationId);
}

type KeyCaller = { organizationId: string; app: VisApp };

/**
 * Who a presented key is, refusing it unless it is live, belongs to the
 * organization this CRM is pinned to (when it is pinned) and carries `scope`.
 */
async function authenticate(
  presented: string | null,
  scope: VisScope,
  pinnedOrganizationId: string | undefined,
): Promise<KeyCaller> {
  if (!presented?.startsWith("vck_")) {
    throw new AppError("UNAUTHENTICATED", "A VisCRM app key is required.");
  }
  const found = await VisKeyRepository.keyByHash(await sha256Hex(presented));
  if (
    !found ||
    (pinnedOrganizationId && found.organizationId !== pinnedOrganizationId)
  ) {
    throw new AppError("UNAUTHENTICATED", "That key is not live.");
  }
  if (!APP_SCOPES[found.app].includes(scope)) {
    throw new AppError(
      "FORBIDDEN",
      `The ${found.app} key can't ${scope.replace(":", " ")}.`,
    );
  }
  await VisKeyRepository.touchKey(
    found.organizationId,
    found.id,
    new Date().toISOString(),
  );
  return { organizationId: found.organizationId, app: found.app };
}

export const KeyService = { mint, revoke, list, authenticate };
