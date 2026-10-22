import { revokeStoredAppleAuthorization } from "./apple-authorization";

type StorageItem = { id: string | null; name: string };
type StorageResult<T> = Promise<{ data: T | null; error: { message: string } | null }>;

type Bucket = {
  list(path: string, options: { limit: number; offset: number; sortBy: { column: string; order: "asc" } }): StorageResult<StorageItem[]>;
  remove(paths: string[]): StorageResult<unknown>;
};

export type AccountDeletionAdmin = {
  storage: { from(bucket: string): Bucket };
  from(table: string): { insert(row: unknown): StorageResult<unknown> };
  auth: { admin: { deleteUser(userId: string): StorageResult<unknown> } };
};

async function listAll(bucket: Bucket, prefix: string) {
  const output: StorageItem[] = [];
  for (let offset = 0; ; offset += 100) {
    const { data, error } = await bucket.list(prefix, { limit: 100, offset, sortBy: { column: "name", order: "asc" } });
    if (error) throw new Error(`storage list: ${error.message}`);
    const page = data ?? [];
    output.push(...page);
    if (page.length < 100) return output;
  }
}

export async function deleteAccount(
  admin: AccountDeletionAdmin,
  userId: string,
  revokeProvider: (admin: AccountDeletionAdmin, userId: string) => Promise<boolean> = async (client, id) =>
    revokeStoredAppleAuthorization(client as unknown as import("@supabase/supabase-js").SupabaseClient, id),
) {
  let providerRevoked = false;
  let manualProviderRevocationRequired = false;
  try {
    providerRevoked = await revokeProvider(admin, userId);
    manualProviderRevocationRequired = !providerRevoked;
  } catch {
    // Apple requires account deletion to continue even when no revocable provider token is available.
    manualProviderRevocationRequired = true;
  }
  const objectPaths: string[] = [];
  for (const bucketName of ["artifacts", "exports"]) {
    const bucket = admin.storage.from(bucketName);
    const bucketPaths: string[] = [];
    const rootItems = await listAll(bucket, userId);
    for (const item of rootItems) {
      if (item.id) {
        bucketPaths.push(`${userId}/${item.name}`);
        continue;
      }
      if (!/^[0-9a-f-]{36}$/i.test(item.name)) throw new Error("unexpected storage folder in user namespace");
      const children = await listAll(bucket, `${userId}/${item.name}`);
      for (const child of children) {
        if (!child.id || child.name.includes("/")) throw new Error("unexpected nested storage object");
        bucketPaths.push(`${userId}/${item.name}/${child.name}`);
      }
    }
    for (let index = 0; index < bucketPaths.length; index += 100) {
      const { error } = await bucket.remove(bucketPaths.slice(index, index + 100));
      if (error) throw new Error(`storage delete: ${error.message}`);
    }
    objectPaths.push(...bucketPaths);
  }

  const audit = await admin.from("audit_events").insert({
    user_id: userId,
    actor_type: "user",
    actor_id: userId,
    action: "account.delete",
    resource_type: "account",
    resource_id: userId,
    purpose: "user_requested_deletion",
    metadata: { storage_objects_removed: objectPaths.length, provider_revoked: providerRevoked, manual_provider_revocation_required: manualProviderRevocationRequired },
  });
  if (audit.error) throw new Error(`deletion audit: ${audit.error.message}`);

  const deleted = await admin.auth.admin.deleteUser(userId);
  if (deleted.error) throw new Error(`auth user deletion: ${deleted.error.message}`);
  return { storageObjectsRemoved: objectPaths.length, providerRevoked, manualProviderRevocationRequired };
}
