import { contentHash, safeConditionalFetch } from "./http";
import type { DNSLookup } from "./safe-url";
import type { SourceReceipt } from "./types";

export type PublicArticle = {
  canonicalUrl: string;
  title: string | null;
  publisher: string | null;
  author: string | null;
  publishedAt: string | null;
  description: string | null;
  text: string;
  receipt: SourceReceipt;
};

function decodeEntities(value: string) {
  const named: Record<string, string> = { amp: "&", quot: '"', apos: "'", lt: "<", gt: ">", nbsp: " " };
  return value.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, entity: string) => {
    if (entity.startsWith("#x")) return String.fromCodePoint(Number.parseInt(entity.slice(2), 16));
    if (entity.startsWith("#")) return String.fromCodePoint(Number.parseInt(entity.slice(1), 10));
    return named[entity.toLowerCase()] ?? match;
  });
}

function clean(value: string | undefined) {
  if (!value) return null;
  const result = decodeEntities(value.replace(/<[^>]*>/g, " ")).replace(/\s+/g, " ").trim();
  return result || null;
}

function attribute(tag: string, name: string) {
  const match = tag.match(new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, "i"));
  return match?.[1] ?? match?.[2] ?? match?.[3];
}

function meta(html: string, keys: string[]) {
  for (const tag of html.match(/<meta\b[^>]*>/gi) ?? []) {
    const key = attribute(tag, "property") ?? attribute(tag, "name") ?? attribute(tag, "itemprop");
    if (key && keys.some((candidate) => candidate.toLowerCase() === key.toLowerCase())) {
      const value = clean(attribute(tag, "content"));
      if (value) return value;
    }
  }
  return null;
}

function canonical(html: string, sourceURL: URL) {
  for (const tag of html.match(/<link\b[^>]*>/gi) ?? []) {
    const rel = attribute(tag, "rel")?.toLowerCase().split(/\s+/) ?? [];
    if (!rel.includes("canonical")) continue;
    const href = attribute(tag, "href");
    if (!href) continue;
    try {
      const url = new URL(href, sourceURL);
      if (["http:", "https:"].includes(url.protocol) && !url.username && !url.password) return url.toString();
    } catch { /* fall through to the fetched URL */ }
  }
  return sourceURL.toString();
}

export function extractArticleHTML(html: string, sourceURL: URL, retrievedAt = new Date()): PublicArticle {
  const withoutNonContent = html
    .replace(/<(script|style|noscript|svg|template)\b[^>]*>[\s\S]*?<\/\1>/gi, " ")
    .replace(/<!--([\s\S]*?)-->/g, " ");
  const body = withoutNonContent.match(/<body\b[^>]*>([\s\S]*?)<\/body>/i)?.[1] ?? withoutNonContent;
  const title = meta(withoutNonContent, ["og:title", "twitter:title"])
    ?? clean(withoutNonContent.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i)?.[1]);
  const publisher = meta(withoutNonContent, ["og:site_name", "publisher"]);
  const author = meta(withoutNonContent, ["author", "article:author"]);
  const publishedAt = meta(withoutNonContent, ["article:published_time", "datePublished", "date"]);
  const description = meta(withoutNonContent, ["description", "og:description", "twitter:description"]);
  const text = decodeEntities(body
    .replace(/<(br|hr)\b[^>]*>/gi, "\n")
    .replace(/<\/(p|div|article|section|main|li|h[1-6]|blockquote)>/gi, "\n")
    .replace(/<[^>]*>/g, " "))
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s*\n+/g, "\n")
    .trim()
    .slice(0, 120_000);
  const canonicalUrl = canonical(withoutNonContent, sourceURL);
  return {
    canonicalUrl,
    title,
    publisher,
    author,
    publishedAt,
    description,
    text,
    receipt: {
      adapter: "public-article",
      adapterVersion: "public-article.v1",
      canonicalUrl,
      title,
      publisher,
      retrievedAt: retrievedAt.toISOString(),
      coverage: text ? "text" : "unavailable",
      contentHash: null,
      metadata: { author, publishedAt, description },
    },
  };
}

export async function fetchPublicArticle(input: {
  url: URL;
  signal?: AbortSignal;
  fetchImplementation?: typeof fetch;
  lookup?: DNSLookup;
  maxBytes?: number;
}) {
  const fetched = await safeConditionalFetch({
    url: input.url,
    ...(input.signal ? { signal: input.signal } : {}),
    ...(input.fetchImplementation ? { fetchImplementation: input.fetchImplementation } : {}),
    ...(input.lookup ? { lookup: input.lookup } : {}),
    maxBytes: input.maxBytes ?? 2_000_000,
  });
  if (!/^(text\/html|application\/xhtml\+xml)(?:;|$)/i.test(fetched.contentType)) {
    throw new Error("public source is not an HTML article");
  }
  const article = extractArticleHTML(new TextDecoder().decode(fetched.body), fetched.url);
  article.receipt.contentHash = contentHash(fetched.body);
  return article;
}
