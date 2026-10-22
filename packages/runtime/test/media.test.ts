import assert from "node:assert/strict";
import { Readable } from "node:stream";
import test from "node:test";
import {
  assertPublicUrl, enrichUrl, enrichYoutube, fetchPublicText, geminiVideoModelOrder, resolvePublicUrl,
  type ResourceAnalysisRequest, type ResourceAnalysisResult, type ResourceFetcher,
  type VideoAnalysisRequest, type VideoAnalysisResult, type VideoAnalyzer, type YoutubeSource, type YoutubeSourceData,
} from "../src/media.ts";

test("content ingestion rejects local and metadata-network targets", async () => {
  await assert.rejects(assertPublicUrl("http://127.0.0.1/private"), /Private|Local/);
  await assert.rejects(assertPublicUrl("http://169.254.169.254/latest/meta-data"), /Private|Local/);
  await assert.rejects(assertPublicUrl("http://[::1]/private"), /Private|Local/);
  await assert.rejects(assertPublicUrl("file:///etc/passwd"), /HTTP/);
});

test("DNS resolution fails closed on mixed public/private answers and pins the approved address", async () => {
  await assert.rejects(resolvePublicUrl("https://example.test/source", async () => [
    { address: "93.184.216.34", family: 4 }, { address: "127.0.0.1", family: 4 },
  ]), /private or non-routable/);
  await assert.rejects(resolvePublicUrl("https://example.test/source", async () => [
    { address: "2606:2800:220:1:248:1893:25c8:1946", family: 6 }, { address: "fd00::1", family: 6 },
  ]), /private or non-routable/);

  let pinned = "";
  const response = Object.assign(Readable.from(["safe body"]), { statusCode: 200, headers: {} as Record<string, string> });
  const fetched = await fetchPublicText("https://example.test/source", {}, 1_000, 0, {
    resolve: (value) => resolvePublicUrl(value, async () => [{ address: "93.184.216.34", family: 4 }]),
    request: async (_url, addresses) => {
      pinned = addresses[0]?.address ?? "";
      return response as never;
    },
  });
  assert.equal(pinned, "93.184.216.34");
  assert.equal(fetched.text, "safe body");
});

test("pinned fetching enforces the response body bound", async () => {
  const oversized = Object.assign(Readable.from(["x".repeat(101)]), { statusCode: 200, headers: {} as Record<string, string> });
  await assert.rejects(fetchPublicText("https://example.test/large", {}, 100, 0, {
    resolve: async (value) => ({ url: new URL(value), addresses: [{ address: "93.184.216.34", family: 4 }] }),
    request: async () => oversized as never,
  }), /exceeds 100 bytes/);
});

test("every redirect target is resolved and private rebinding is rejected before a second request", async () => {
  let requests = 0;
  const redirect = Object.assign(Readable.from([]), {
    statusCode: 302,
    headers: { location: "http://127.0.0.1/private" },
  });
  await assert.rejects(fetchPublicText("https://example.test/start", {}, 1_000, 5, {
    resolve: async (value) => value.includes("example.test")
      ? { url: new URL(value), addresses: [{ address: "93.184.216.34", family: 4 }] }
      : resolvePublicUrl(value),
    request: async () => {
      requests += 1;
      return redirect as never;
    },
  }), /Private|Local/);
  assert.equal(requests, 1);
});

test("native media uses Flash-Lite first and escalates without duplicate calls", () => {
  assert.deepEqual(geminiVideoModelOrder("gemini-3.5-flash-lite"), ["gemini-3.5-flash-lite", "gemini-3.6-flash", "gemini-2.5-flash"]);
  assert.deepEqual(geminiVideoModelOrder("gemini-3.6-flash"), ["gemini-3.6-flash", "gemini-2.5-flash"]);
});

class FakeAnalyzer implements VideoAnalyzer {
  readonly name = "fake-native-video";
  readonly calls: VideoAnalysisRequest[] = [];

  async analyze(request: VideoAnalysisRequest): Promise<VideoAnalysisResult> {
    this.calls.push(request);
    if (request.prompt.includes("Transcribe the speech")) {
      return { status: "ok", text: `[${request.startSeconds ?? 0}] native transcript`, model: "fake" };
    }
    return { status: "ok", text: "visual evidence at [1:20]", model: "fake" };
  }

  async synthesize(prompt: string): Promise<string | undefined> {
    return `combined ${prompt.length}`;
  }
}

class FakeResourceAnalyzer extends FakeAnalyzer {
  readonly resourceCalls: ResourceAnalysisRequest[] = [];

  async analyzeResource(request: ResourceAnalysisRequest): Promise<ResourceAnalysisResult> {
    this.resourceCalls.push(request);
    if (request.mimeType.startsWith("image/")) return { status: "ok", text: "A diagram with legible labels and a blue arrow.", model: "fake-resource" };
    if (request.mimeType.startsWith("audio/")) return { status: "ok", text: "[0:00] Speaker: exact spoken evidence.", model: "fake-resource" };
    return { status: "ok", text: "Page 1: the document makes a bounded factual claim.", model: "fake-resource" };
  }
}

function resources(entries: Record<string, { status?: number; type: string; body: string | Buffer }>): ResourceFetcher {
  return async (url) => {
    const entry = entries[url];
    if (!entry) throw new Error(`Unexpected resource ${url}`);
    return {
      status: entry.status ?? 200,
      headers: { "content-type": entry.type },
      body: Buffer.isBuffer(entry.body) ? entry.body : Buffer.from(entry.body),
      url,
    };
  };
}

function source(input: YoutubeSourceData): YoutubeSource {
  return { inspect: async () => input };
}

test("short YouTube videos retain exact captions and add native visual evidence", async () => {
  const analyzer = new FakeAnalyzer();
  const result = await enrichYoutube("https://youtu.be/abcdefghijk", {
    analyzer,
    source: source({
      title: "A short film", author: "Maker", durationSeconds: 420, description: "description",
      transcript: "the exact words from captions", transcriptSource: "manual-captions", metadata: { id: "abcdefghijk" },
    }),
  });
  assert.equal(result.coverage, "transcript+multimodal");
  assert.equal(result.deferred, false);
  assert.match(result.content, /the exact words from captions/);
  assert.match(result.content, /visual evidence at \[1:20\]/);
  assert.equal(analyzer.calls.length, 1);
  assert.equal(analyzer.calls[0]?.fps, 0.5);
});

test("long captioned YouTube videos use the durable transcript without an expensive native watch", async () => {
  const analyzer = new FakeAnalyzer();
  const result = await enrichYoutube("https://www.youtube.com/watch?v=abcdefghijk", {
    analyzer,
    deferSeconds: 720,
    source: source({
      title: "Long podcast", durationSeconds: 3_600, description: "", transcript: "complete caption transcript",
      transcriptSource: "automatic-captions", metadata: { id: "abcdefghijk" },
    }),
  });
  assert.equal(result.coverage, "transcript");
  assert.equal(result.deferred, true);
  assert.equal(analyzer.calls.length, 0);
});

test("captionless long videos are transcribed in bounded native-video windows", async () => {
  const analyzer = new FakeAnalyzer();
  const result = await enrichYoutube("https://youtube.com/watch?v=abcdefghijk", {
    analyzer,
    deferSeconds: 720,
    maxWindows: 8,
    source: source({ title: "Long video", durationSeconds: 3_600, description: "", metadata: { id: "abcdefghijk" } }),
  });
  assert.equal(result.coverage, "transcript");
  assert.equal(result.deferred, true);
  assert.equal(analyzer.calls.length, 4);
  assert.deepEqual(analyzer.calls.map((call) => [call.startSeconds, call.endSeconds]), [[0, 900], [900, 1_800], [1_800, 2_700], [2_700, 3_600]]);
  assert.match(result.content, /native transcript/);
  assert.equal(result.metadata.partial, false);
});

test("a YouTube watch-page fallback never claims that page text is video full text", async () => {
  const url = "https://www.youtube.com/watch?v=abcdefghijk";
  const result = await enrichUrl(url, {
    source: { inspect: async () => { throw new Error("captions unavailable"); } },
    fetchResource: resources({
      [url]: {
        type: "text/html; charset=utf-8",
        body: `<html><head><title>Video title</title></head><body><main>${"Recommended video and page chrome. ".repeat(8)}</main></body></html>`,
      },
    }),
  });
  assert.equal(result.kind, "youtube");
  assert.equal(result.coverage, "watch-page-text");
  assert.match(result.content, /VIDEO ITSELF WAS NOT TRANSCRIBED OR WATCHED/);
  assert.equal(result.metadata.extraction, "visible YouTube watch-page text; video not inspected");
});

test("articles are stored as bounded full text rather than mislabeled metadata", async () => {
  const url = "https://example.com/essay";
  const result = await enrichUrl(url, { fetchResource: resources({
    [url]: {
      type: "text/html; charset=utf-8",
      body: `<html><head><title>Fallback title</title><meta property="og:title" content="A precise essay"><meta name="author" content="Ada"></head><body><script>ignore me</script><article><h1>A claim</h1><p>${"Supported detail. ".repeat(12)}</p></article></body></html>`,
    },
  }) });
  assert.equal(result.kind, "article");
  assert.equal(result.coverage, "fulltext");
  assert.equal(result.title, "A precise essay");
  assert.equal(result.author, "Ada");
  assert.match(result.content, /Supported detail/);
  assert.doesNotMatch(result.content, /ignore me/);
  assert.equal(result.metadata.extraction, "visible HTML text");
});

test("documents, images, and audio use typed native analysis with honest coverage", async () => {
  const analyzer = new FakeResourceAnalyzer();
  const fetchResource = resources({
    "https://cdn.example.com/report.pdf": { type: "application/pdf", body: Buffer.from("pdf bytes") },
    "https://cdn.example.com/diagram.png": { type: "image/png", body: Buffer.from("image bytes") },
    "https://cdn.example.com/episode.mp3": { type: "audio/mpeg", body: Buffer.from("audio bytes") },
  });
  const document = await enrichUrl("https://cdn.example.com/report.pdf", { analyzer, fetchResource });
  const image = await enrichUrl("https://cdn.example.com/diagram.png", { analyzer, fetchResource });
  const audio = await enrichUrl("https://cdn.example.com/episode.mp3", { analyzer, fetchResource });
  assert.deepEqual([document.kind, document.coverage], ["document", "document"]);
  assert.deepEqual([image.kind, image.coverage], ["image", "multimodal"]);
  assert.deepEqual([audio.kind, audio.coverage], ["podcast", "transcript"]);
  assert.equal(analyzer.resourceCalls.length, 3);
  assert.equal(analyzer.resourceCalls.every((call) => call.prompt.includes("untrusted source material")), true);
});

test("unsupported binary content stays metadata-only instead of being decoded as text", async () => {
  const url = "https://cdn.example.com/archive.zip";
  const result = await enrichUrl(url, { fetchResource: resources({ [url]: { type: "application/zip", body: Buffer.from([0, 255, 1, 254]) } }) });
  assert.equal(result.kind, "web");
  assert.equal(result.coverage, "metadata");
  assert.doesNotMatch(result.content, /�/);
});

test("GitHub repository coverage means metadata plus README, never an uninspected source tree", async () => {
  const url = "https://github.com/acme/rocket";
  const api = "https://api.github.com/repos/acme/rocket";
  const result = await enrichUrl(url, { fetchResource: resources({
    [api]: {
      type: "application/json",
      body: JSON.stringify({ full_name: "acme/rocket", description: "A useful system", language: "TypeScript", topics: ["agents"], default_branch: "main", stargazers_count: 42, license: { spdx_id: "MIT" } }),
    },
    [`${api}/readme`]: { type: "text/markdown", body: `# Rocket\n\n${"Architecture and usage evidence. ".repeat(5)}` },
  }) });
  assert.equal(result.kind, "repository");
  assert.equal(result.coverage, "repository-overview");
  assert.match(result.content, /README/);
  assert.equal(result.metadata.scope, "repository metadata and README; source tree not inspected");
});

test("shared transcript files become conversation evidence with transcript coverage", async () => {
  const url = "https://cdn.example.com/call-transcript.vtt";
  const result = await enrichUrl(url, { fetchResource: resources({
    [url]: { type: "text/vtt", body: "WEBVTT\n\n00:00.000 --> 00:02.000\nA precise conversation excerpt." },
  }) });
  assert.equal(result.kind, "conversation");
  assert.equal(result.coverage, "transcript");
});
