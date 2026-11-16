import { and, desc, eq, isNull } from "drizzle-orm";
import { db } from "@/db";
import { runBatch } from "@/db/runBatch";
import { visAppKey } from "@/db/schema";
import type { VisApp } from "@/shared/vis";

// The sibling apps' write keys. Every read and write takes the organization
// except `keyByHash`: an incoming key names its own organization.
/**
 * Replaces the app's live key with this one in one batch: the old key is
 * revoked only together with the new one going in.
 */
async function rotateKey(values: typeof visAppKey.$inferInsert, at: string) {
  await runBatch((tx) => [
    tx
      .update(visAppKey)
      .set({ revokedAt: at })
      .where(
        and(
          eq(visAppKey.organizationId, values.organizationId),
          eq(visAppKey.app, values.app),
          isNull(visAppKey.revokedAt),
        ),
      ),
    tx.insert(visAppKey).values(values),
  ]);
}

/** The live key with this hash, whoever's it is: the key names its org. */
async function keyByHash(keyHash: string) {
  const [found] = await db
    .select()
    .from(visAppKey)
    .where(and(eq(visAppKey.keyHash, keyHash), isNull(visAppKey.revokedAt)))
    .limit(1);
  return found ?? null;
}

async function touchKey(organizationId: string, id: string, at: string) {
  await db
    .update(visAppKey)
    .set({ lastUsedAt: at })
    .where(
      and(eq(visAppKey.organizationId, organizationId), eq(visAppKey.id, id)),
    );
}

async function listKeys(organizationId: string) {
  return db
    .select({
      id: visAppKey.id,
      app: visAppKey.app,
      label: visAppKey.label,
      keyPrefix: visAppKey.keyPrefix,
      lastUsedAt: visAppKey.lastUsedAt,
      revokedAt: visAppKey.revokedAt,
      createdAt: visAppKey.createdAt,
    })
    .from(visAppKey)
    .where(eq(visAppKey.organizationId, organizationId))
    .orderBy(desc(visAppKey.createdAt));
}

/** Revokes the app's live key; true when there was one. */
async function revokeKey(organizationId: string, app: VisApp, at: string) {
  const revoked = await db
    .update(visAppKey)
    .set({ revokedAt: at })
    .where(
      and(
        eq(visAppKey.organizationId, organizationId),
        eq(visAppKey.app, app),
        isNull(visAppKey.revokedAt),
      ),
    )
    .returning({ id: visAppKey.id });
  return revoked.length > 0;
}

export const VisKeyRepository = {
  rotateKey,
  keyByHash,
  touchKey,
  listKeys,
  revokeKey,
};
