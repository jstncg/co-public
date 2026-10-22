import { describe, expect, it, vi } from "vitest";
import { assertOwnedObjectPaths, createUploadSlots } from "./upload-service";

describe("private upload slots", () => {
  it("always scopes server-generated paths to the authenticated user and artifact", async () => {
    const createSignedUploadUrl = vi.fn(async (path: string) => ({ data: { path, signedUrl: `https://upload.test/${path}?token=signed`, token: "signed" }, error: null }));
    const admin: any = { storage: { from: vi.fn(() => ({ createSignedUploadUrl })) } };
    const result = await createUploadSlots(admin, "0198c5d2-bfed-75e0-b7d1-8a89b7c04110", {
      clientArtifactId: "0198c5d2-bfed-75e0-b7d1-8a89b7c04111",
      attachments: [{ filename: "../../photo.HEIC", mimeType: "image/heic", byteCount: 42 }],
    });
    expect(result.slots[0]?.path).toMatch(/^0198c5d2-bfed-75e0-b7d1-8a89b7c04110\/0198c5d2-bfed-75e0-b7d1-8a89b7c04111\/[0-9a-f-]+\.heic$/);
  });

  it("rejects an object key outside the authenticated namespace", () => {
    expect(() => assertOwnedObjectPaths("user-a", "artifact-a", ["user-b/artifact-a/file"])).toThrow("invalid_object_path");
  });
});
