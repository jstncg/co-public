import { contentHash, safeConditionalFetch } from "./http";
import type { ConditionalSourceAdapter } from "./types";

export class HTTPChangeAdapter implements ConditionalSourceAdapter {
  readonly id = "public_http_change";
  readonly version = "public-http-change.v1";

  constructor(private readonly fetchImplementation: typeof fetch = fetch) {}

  async poll(input: Parameters<ConditionalSourceAdapter["poll"]>[0] & { previousContentHash?: string }) {
    const fetched = await safeConditionalFetch({ ...input, fetchImplementation: this.fetchImplementation, maxBytes: 2_000_000 });
    const conditional = { ...(fetched.etag ? { etag: fetched.etag } : {}), ...(fetched.lastModified ? { lastModified: fetched.lastModified } : {}) };
    if (fetched.notModified) return { status: "unchanged" as const, ...conditional, items: [] };
    const hash = contentHash(fetched.body);
    if (hash === input.previousContentHash) return { status: "unchanged" as const, ...conditional, items: [] };
    const retrievedAt = new Date().toISOString();
    return {
      status: "changed" as const,
      ...conditional,
      items: [{
        externalId: hash,
        title: fetched.url.hostname,
        summary: null,
        url: fetched.url.toString(),
        publishedAt: null,
        receipt: {
          adapter: this.id,
          adapterVersion: this.version,
          canonicalUrl: fetched.url.toString(),
          title: fetched.url.hostname,
          publisher: fetched.url.hostname,
          retrievedAt,
          coverage: "text" as const,
          contentHash: hash,
          metadata: { contentType: fetched.contentType },
        },
      }],
    };
  }
}
