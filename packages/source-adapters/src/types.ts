export type SourceReceipt = {
  adapter: string;
  adapterVersion: string;
  canonicalUrl: string;
  title: string | null;
  publisher: string | null;
  retrievedAt: string;
  coverage: "full_media" | "image" | "text" | "url_only" | "unavailable";
  contentHash: string | null;
  metadata: Record<string, string | number | boolean | null>;
};

export type WorldSourceItem = {
  externalId: string;
  title: string;
  summary: string | null;
  url: string;
  publishedAt: string | null;
  receipt: SourceReceipt;
};

export interface ConditionalSourceAdapter {
  readonly id: string;
  readonly version: string;
  poll(input: {
    url: URL;
    etag?: string | undefined;
    lastModified?: string | undefined;
    signal?: AbortSignal | undefined;
  }): Promise<{
    status: "unchanged" | "changed";
    etag?: string | undefined;
    lastModified?: string | undefined;
    items: WorldSourceItem[];
  }>;
}
