/** chunk + embed artifact text into artifact_segments (pgvector). batch non-urgent embeddings (§25.6). */
import { task } from "@trigger.dev/sdk/v3";
import { makeProvider } from "@co/model-gateway";
import { serviceDb, must } from "../lib/db";

export interface EmbedSegmentsPayload {
  artifactId: string;
  idempotencyKey: string;
}

const CHUNK_CHARS = 800;

export function chunkText(text: string, size = CHUNK_CHARS): string[] {
  const chunks: string[] = [];
  let rest = text.trim();
  while (rest.length > size) {
    // prefer a sentence boundary in the back half of the chunk
    const slice = rest.slice(0, size);
    const cut = Math.max(slice.lastIndexOf(". "), slice.lastIndexOf("\n"));
    const at = cut > size / 2 ? cut + 1 : size;
    chunks.push(rest.slice(0, at).trim());
    rest = rest.slice(at).trim();
  }
  if (rest) chunks.push(rest);
  return chunks;
}

export const embedSegments = task({
  id: "embed-segments",
  run: async (payload: EmbedSegmentsPayload) => {
    const db = serviceDb();
    const artifact = must(
      await db.from("artifacts").select("id,raw_text,transcript,retention_mode,deleted_at").eq("id", payload.artifactId).maybeSingle(),
      "load artifact",
    ) as Record<string, unknown>;

    if (artifact.deleted_at) return { skipped: "deleted" };
    if (artifact.retention_mode === "no_analysis") return { skipped: "no_analysis" }; // no embeddings, ever (§37 jordan)

    const text = [(artifact.raw_text as string | null), (artifact.transcript as string | null)].filter(Boolean).join("\n\n");
    if (!text.trim()) return { skipped: "no_text" };

    const chunks = chunkText(text);
    const provider = makeProvider(process.env);
    const embeddings = await provider.embed(chunks);

    // re-run safe: replace segments for this artifact atomically enough for a derived table.
    await db.from("artifact_segments").delete().eq("artifact_id", payload.artifactId);
    must(
      await db.from("artifact_segments").insert(
        chunks.map((chunk, i) => ({
          artifact_id: payload.artifactId,
          segment_type: "text_chunk",
          start_offset: null,
          end_offset: null,
          text: chunk,
          embedding: embeddings[i],
          metadata: { chunk_index: i },
        })),
      ).select("id"),
      "insert segments",
    );
    return { segments: chunks.length };
  },
});
