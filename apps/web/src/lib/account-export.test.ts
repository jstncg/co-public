import { describe, expect, it, vi } from "vitest";
import { createAccountExport } from "./account-export";

class ExportQuery {
  readonly calls: Array<{ method: string; args: unknown[] }> = [];
  constructor(private readonly table: string) {}
  insert(...args: unknown[]) { this.calls.push({ method: "insert", args }); return this; }
  update(...args: unknown[]) { this.calls.push({ method: "update", args }); return this; }
  select(...args: unknown[]) { this.calls.push({ method: "select", args }); return this; }
  eq(...args: unknown[]) { this.calls.push({ method: "eq", args }); return this; }
  range(...args: unknown[]) {
    this.calls.push({ method: "range", args });
    return Promise.resolve({ data: this.table === "profiles" ? [{ id: "user-1", display_name: "Ada" }] : [], error: null });
  }
  single<T>() { return Promise.resolve({ data: { id: "request-1" } as T, error: null }); }
  then(resolve: (value: { data: null; error: null }) => unknown) { return Promise.resolve(resolve({ data: null, error: null })); }
}

describe("account export", () => {
  it("exports scoped rows without vectors or device tokens and returns a short-lived private URL", async () => {
    const queries: ExportQuery[] = [];
    const upload = vi.fn(async (_path: string, _body: Uint8Array, _options: unknown) => ({ data: { path: "user-1/request-1.json" }, error: null }));
    const createSignedUrl = vi.fn(async (_path: string, _expiresIn: number, _options: unknown) => ({ data: { signedUrl: "https://private.test/signed" }, error: null }));
    const database: any = {
      from(table: string) { const query = new ExportQuery(table); queries.push(query); return query; },
      rpc: vi.fn(async () => ({ data: {
        model_runs: [], external_queries: [], review_decisions: [], shadow_comparisons: [],
        apple_authorization: { stored: false }, transport_phone_link: null,
      }, error: null })),
      storage: { from: vi.fn(() => ({ upload, createSignedUrl })) },
    };
    const now = new Date("2026-07-20T12:00:00.000Z");

    await expect(createAccountExport(database, "user-1", now)).resolves.toEqual({
      downloadURL: "https://private.test/signed",
      expiresAt: "2026-07-20T12:15:00.000Z",
    });

    expect(upload).toHaveBeenCalledOnce();
    expect(upload.mock.calls[0]?.[0]).toBe("user-1/request-1.json");
    const payload = JSON.parse(new TextDecoder().decode(upload.mock.calls[0]?.[1] as Uint8Array));
    expect(payload).toMatchObject({ format: "co-account-export.v1", userId: "user-1" });
    expect(payload.tables["public.profiles"]).toEqual([{ id: "user-1", display_name: "Ada" }]);
    expect(payload.tables["public.messages"]).toEqual([]);
    expect(payload.tables["private.apple_authorization"]).toEqual({ stored: false });
    expect(payload.notes).toContain("Vector embeddings and APNs device tokens are omitted.");
    expect(createSignedUrl).toHaveBeenCalledWith("user-1/request-1.json", 900, { download: "co-export-2026-07-20.json" });

    const selectedColumns = queries.flatMap((query) => query.calls)
      .filter((call) => call.method === "select")
      .map((call) => String(call.args[0]));
    expect(selectedColumns.some((columns) => columns.includes("embedding"))).toBe(false);
    expect(selectedColumns.some((columns) => columns.includes("apns"))).toBe(false);
    expect(queries.flatMap((query) => query.calls).filter((call) => call.method === "eq"))
      .toEqual(expect.arrayContaining([expect.objectContaining({ args: ["user_id", "user-1"] })]));
  });
});
