import { createHash } from "node:crypto";
import { assertSafePublicURL, type DNSLookup } from "./safe-url";

export type SafeFetchResult = {
  url: URL;
  body: Uint8Array;
  contentType: string;
  etag?: string | undefined;
  lastModified?: string | undefined;
  notModified: boolean;
};

export async function safeConditionalFetch(input: {
  url: URL;
  etag?: string | undefined;
  lastModified?: string | undefined;
  signal?: AbortSignal | undefined;
  fetchImplementation?: typeof fetch | undefined;
  lookup?: DNSLookup | undefined;
  maxBytes?: number | undefined;
  maxRedirects?: number | undefined;
}): Promise<SafeFetchResult> {
  const fetchImplementation = input.fetchImplementation ?? fetch;
  const maxBytes = input.maxBytes ?? 2_000_000;
  let current = new URL(input.url);
  const headers = new Headers({ accept: "application/rss+xml, application/atom+xml, application/xml, text/xml, text/html;q=0.8" });
  if (input.etag) headers.set("if-none-match", input.etag);
  if (input.lastModified) headers.set("if-modified-since", input.lastModified);

  for (let redirect = 0; redirect <= (input.maxRedirects ?? 3); redirect += 1) {
    await assertSafePublicURL(current, input.lookup);
    const response = await fetchImplementation(current, {
      headers,
      redirect: "manual",
      ...(input.signal ? { signal: input.signal } : {}),
    });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get("location");
      if (!location || redirect === (input.maxRedirects ?? 3)) throw new Error("source redirect limit exceeded");
      current = new URL(location, current);
      continue;
    }
    if (response.status === 304) return { url: current, body: new Uint8Array(), contentType: "", notModified: true };
    if (!response.ok) throw new Error(`source returned HTTP ${response.status}`);
    const declared = Number(response.headers.get("content-length") ?? 0);
    if (declared > maxBytes) throw new Error("source exceeds content limit");
    const body = new Uint8Array(await response.arrayBuffer());
    if (body.byteLength > maxBytes) throw new Error("source exceeds content limit");
    const result: SafeFetchResult = {
      url: current,
      body,
      contentType: response.headers.get("content-type") ?? "application/octet-stream",
      notModified: false,
    };
    const etag = response.headers.get("etag");
    const lastModified = response.headers.get("last-modified");
    if (etag) result.etag = etag;
    if (lastModified) result.lastModified = lastModified;
    return result;
  }
  throw new Error("unreachable redirect state");
}

export function contentHash(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}
