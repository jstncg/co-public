import {
  evidenceSegmentSchema,
  immediateResponseSchema,
  signalCandidateSchema,
  type ConsentState,
  type EvidenceSegment,
  type ImmediateResponse,
  type SignalCandidate,
} from "@co/contracts";
import { createModelProvider, type PipelineArtifactInput as ArtifactInput, type PipelineModelProvider as ModelProvider } from "@co/model-gateway";
import { fetchPublicArticle, type PublicArticle } from "@co/source-adapters";
import { routeSignalUsefulness } from "@co/intelligence";
import type { SupabaseClient } from "@supabase/supabase-js";

type ArtifactRow = {
  id: string;
  user_id: string;
  source_type: string;
  source_coverage: "full_media" | "image" | "text" | "url_only" | "unavailable";
  canonical_url: string | null;
  raw_text: string | null;
  transcript: string | null;
  raw_object_path: string | null;
  mime_type: string | null;
  retention_mode: "default" | "keep_raw" | "delete_after_processing" | "local_only";
  user_note: string | null;
  analysis_allowed: boolean;
  processing_status: string;
  captured_at: string;
  occurred_at: string | null;
  provenance_class: "owner" | "participant" | "external" | "system";
  consent_state: ConsentState;
};

type SegmentRow = EvidenceSegment & { id: string };

type LoadedMedia = { data: Uint8Array; mimeType: string };

function inferredMIME(path: string, sourceType: string) {
  const extension = path.split(".").pop()?.toLowerCase();
  if (extension === "jpg" || extension === "jpeg") return "image/jpeg";
  if (extension === "png") return "image/png";
  if (extension === "webp") return "image/webp";
  if (extension === "m4a") return "audio/m4a";
  if (extension === "mp3") return "audio/mpeg";
  if (extension === "wav") return "audio/wav";
  if (extension === "webm") return "audio/webm";
  if (extension === "mp4" && ["voice", "call", "meeting", "video"].includes(sourceType)) return "audio/mp4";
  return "application/octet-stream";
}

async function loadPrivateMedia(admin: SupabaseClient, artifact: ArtifactRow): Promise<LoadedMedia> {
  if (!artifact.raw_object_path) throw new Error("artifact has no media object");
  const downloaded = await admin.storage.from("artifacts").download(artifact.raw_object_path);
  if (downloaded.error || !downloaded.data) throw new Error(`media download: ${downloaded.error?.message ?? "empty"}`);
  const mimeType = artifact.mime_type ?? (downloaded.data.type || inferredMIME(artifact.raw_object_path, artifact.source_type));
  return { data: new Uint8Array(await downloaded.data.arrayBuffer()), mimeType };
}

export function classifyExplicitRequest(note: string | null) {
  const value = note?.toLowerCase() ?? "";
  if (/(summar|not reading|tl;?dr)/.test(value)) return "summary" as const;
  if (/(funny|made me laugh|humou?r|meme|react to this)/.test(value)) return "react" as const;
  return "none" as const;
}

export function enforceSignalProvenance(signal: SignalCandidate, segments: EvidenceSegment[]): SignalCandidate {
  if (signal.subject_relation !== "user") return signal;
  const supporting = new Set(signal.supporting_segment_keys);
  const hasFirstPartyEvidence = segments.some((segment) =>
    supporting.has(segment.segment_key) && segment.speaker_relation === "user"
  );
  if (hasFirstPartyEvidence) return signal;
  return signalCandidateSchema.parse({
    ...signal,
    subject_relation: signal.signal_type === "source_claim" ? "source" : "unknown",
    confidence: Math.min(signal.confidence, 0.5),
    uncertainty: signal.uncertainty ?? "No first-party segment supports attributing this statement to the user.",
  });
}

async function compileAndPersistSignals(
  admin: SupabaseClient,
  input: {
    artifact: ArtifactRow;
    modelInput: ArtifactInput;
    segments: SegmentRow[];
    provider: ModelProvider;
  },
) {
  if (!input.provider.compileSignals || input.segments.length === 0) return { signals: 0, usefulness: 0 };
  const compiled = await input.provider.compileSignals({
    ...input.modelInput,
    evidenceSegments: input.segments.map(({ id: _id, ...segment }) => segment),
  });
  const compilerRun = await admin.schema("private").from("model_runs").insert({
    user_id: input.artifact.user_id,
    task_type: "signal_compilation",
    provider: compiled.meta.provider,
    model: compiled.meta.model,
    prompt_version: compiled.meta.promptVersion,
    input_artifact_ids: [input.artifact.id],
    output_schema_version: compiled.meta.schemaVersion,
    latency_ms: compiled.meta.latencyMs,
    input_tokens: compiled.meta.inputTokens,
    output_tokens: compiled.meta.outputTokens,
    status: "succeeded",
    uncertainty_summary: compiled.value.signals.filter((signal) => signal.uncertainty).map((signal) => signal.uncertainty),
  }).select("id").single<{ id: string }>();
  if (compilerRun.error) throw compilerRun.error;

  const staleSignals = await admin.from("signal_candidates").delete()
    .eq("artifact_id", input.artifact.id).eq("user_id", input.artifact.user_id).eq("status", "proposed");
  if (staleSignals.error) throw staleSignals.error;

  const byKey = new Map(input.segments.map((segment) => [segment.segment_key, segment.id]));
  const normalized = compiled.value.signals
    .map((signal) => enforceSignalProvenance(signal, input.segments))
    .filter((signal) => signal.supporting_segment_keys.some((key) => byKey.has(key)));
  if (normalized.length === 0) return { signals: 0, usefulness: 0 };

  const inserted = await admin.from("signal_candidates").insert(normalized.map((signal) => ({
    user_id: input.artifact.user_id,
    artifact_id: input.artifact.id,
    signal_type: signal.signal_type,
    subject_relation: signal.subject_relation,
    statement: signal.statement,
    confidence: signal.confidence,
    supporting_segment_ids: signal.supporting_segment_keys.flatMap((key) => byKey.get(key) ?? []),
    contradicting_segment_ids: signal.contradicting_segment_keys.flatMap((key) => byKey.get(key) ?? []),
    uncertainty: signal.uncertainty,
    sensitivity: signal.sensitivity,
    status: "proposed",
    model_run_id: compilerRun.data.id,
    compiler_version: compiled.meta.schemaVersion,
  }))).select("id");
  if (inserted.error) throw inserted.error;
  const signalRows = (inserted.data ?? []) as Array<{ id: string }>;

  const explicitRequest = classifyExplicitRequest(input.artifact.user_note);
  const explicitWatchRequest = /(keep me posted|watch this|track this|let me know)/i.test(input.artifact.user_note ?? "");
  const evidenceTime = Date.parse(input.artifact.occurred_at ?? input.artifact.captured_at);
  const evidenceAgeDays = Number.isFinite(evidenceTime)
    ? Math.max(0, (Date.now() - evidenceTime) / 86_400_000)
    : 0;
  const repeatableStatements = [...new Set(normalized
    .filter((signal) =>
      signal.subject_relation === "user" &&
      ["user_statement", "preference"].includes(signal.signal_type)
    )
    .map((signal) => signal.statement))];
  const priorCounts = new Map<string, number>();
  if (repeatableStatements.length > 0) {
    const prior = await admin.from("signal_candidates").select("statement")
      .eq("user_id", input.artifact.user_id)
      .neq("artifact_id", input.artifact.id)
      .eq("subject_relation", "user")
      .in("status", ["proposed", "accepted"])
      .in("statement", repeatableStatements);
    if (prior.error) throw prior.error;
    for (const row of prior.data ?? []) {
      const statement = String(row.statement);
      priorCounts.set(statement, (priorCounts.get(statement) ?? 0) + 1);
    }
  }
  const usefulnessRows = normalized.flatMap((signal, index) => {
    const signalId = signalRows[index]?.id;
    if (!signalId) return [];
    const routed = routeSignalUsefulness(signal, {
      explicitRequest,
      liveContextMatch: false,
      repeatedEvidenceCount: 1 + (priorCounts.get(signal.statement) ?? 0),
      explicitWatchRequest,
      consentState: input.artifact.consent_state,
      sourceType: input.artifact.source_type,
      evidenceAgeDays,
    });
    return [{
      user_id: input.artifact.user_id,
      artifact_id: input.artifact.id,
      signal_id: signalId,
      lane: routed.lane,
      reason: routed.reason,
      supporting_segment_ids: routed.supporting_segment_keys.flatMap((key) => byKey.get(key) ?? []),
      relevance: routed.relevance,
      novelty: routed.novelty,
      actionability: routed.actionability,
      status: "proposed",
      requires_review: true,
      router_version: "usefulness-router.v1",
      not_before: routed.not_before,
    }];
  });
  if (usefulnessRows.length > 0) {
    const usefulness = await admin.from("usefulness_candidates").insert(usefulnessRows);
    if (usefulness.error) throw usefulness.error;
  }
  return { signals: normalized.length, usefulness: usefulnessRows.length };
}

export async function processArtifact(
  admin: SupabaseClient,
  input: { artifactId: string; userId: string; failForRetry?: boolean; signalRefineryEnabled?: boolean },
  provider: ModelProvider = createModelProvider(),
  articleLoader: (input: { url: URL }) => Promise<PublicArticle> = fetchPublicArticle,
  mediaLoader: (admin: SupabaseClient, artifact: ArtifactRow) => Promise<LoadedMedia> = loadPrivateMedia,
): Promise<{ status: "ready" | "failed_safe" | "already_complete"; immediate: ImmediateResponse }> {
  const existingResponse = await admin.from("artifact_responses").select("mode, response, why_question, suggested_actions, confidence")
    .eq("artifact_id", input.artifactId).eq("user_id", input.userId).maybeSingle();
  if (existingResponse.error) throw existingResponse.error;
  if (existingResponse.data) {
    return { status: "already_complete", immediate: immediateResponseSchema.parse(existingResponse.data) };
  }

  const selected = await admin.from("artifacts").select("id, user_id, source_type, source_coverage, canonical_url, raw_text, transcript, raw_object_path, mime_type, retention_mode, user_note, analysis_allowed, processing_status, captured_at, occurred_at, provenance_class, consent_state")
    .eq("id", input.artifactId).eq("user_id", input.userId).is("deleted_at", null).single<ArtifactRow>();
  if (selected.error) throw selected.error;
  const artifact = selected.data;
  if (!artifact.analysis_allowed) throw new Error("analysis is not allowed for this artifact");

  const claimed = await admin.from("artifacts").update({ processing_status: "processing" })
    .eq("id", artifact.id).eq("user_id", input.userId).in("processing_status", ["queued", "processing", "failed_safe"]);
  if (claimed.error) throw claimed.error;

  try {
    let modelInput: ArtifactInput = {
      artifactId: artifact.id,
      sourceType: artifact.source_type,
      sourceCoverage: artifact.source_coverage,
      normalizedText: artifact.raw_text ?? artifact.transcript,
      canonicalUrl: artifact.canonical_url,
      userNote: artifact.user_note,
    };
    if (artifact.raw_object_path && ["voice", "call", "meeting", "video"].includes(artifact.source_type) && !artifact.transcript) {
      const media = await mediaLoader(admin, artifact);
      if (!new Set(["audio/m4a", "audio/mp4", "audio/mpeg", "audio/wav", "audio/webm"]).has(media.mimeType)) throw new Error("unsupported audio type");
      const transcription = await provider.transcribeAudio(media.data, media.mimeType);
      const transcript = transcription.value.trim();
      if (!transcript) throw new Error("empty transcript");
      const transcriptUpdate = await admin.from("artifacts").update({ transcript, mime_type: media.mimeType })
        .eq("id", artifact.id).eq("user_id", input.userId);
      if (transcriptUpdate.error) throw transcriptUpdate.error;
      modelInput = { ...modelInput, normalizedText: transcript };
      if (artifact.retention_mode === "delete_after_processing") {
        const removed = await admin.storage.from("artifacts").remove([artifact.raw_object_path]);
        if (removed.error) throw removed.error;
        const cleared = await admin.from("artifacts").update({ raw_object_path: null })
          .eq("id", artifact.id).eq("user_id", input.userId);
        if (cleared.error) throw cleared.error;
      }
      const transcriptionRun = await admin.schema("private").from("model_runs").insert({
        user_id: input.userId, task_type: "transcription", provider: transcription.meta.provider,
        model: transcription.meta.model, prompt_version: transcription.meta.promptVersion,
        input_artifact_ids: [artifact.id], output_schema_version: transcription.meta.schemaVersion,
        latency_ms: transcription.meta.latencyMs, input_tokens: transcription.meta.inputTokens,
        output_tokens: transcription.meta.outputTokens, status: "succeeded", uncertainty_summary: [],
      });
      if (transcriptionRun.error) throw transcriptionRun.error;
    } else if (artifact.raw_object_path && ["image", "screenshot"].includes(artifact.source_type)) {
      const media = await mediaLoader(admin, artifact);
      if (!new Set(["image/jpeg", "image/png", "image/webp"]).has(media.mimeType)) throw new Error("unsupported image type");
      modelInput = { ...modelInput, imageDataUrl: `data:${media.mimeType};base64,${Buffer.from(media.data).toString("base64")}` };
    }
    if (artifact.canonical_url && artifact.source_coverage === "url_only") {
      try {
        const article = await articleLoader({ url: new URL(artifact.canonical_url) });
        if (article.text) {
          const metadataUpdate = await admin.from("artifacts").update({
            title: article.title,
            publisher: article.publisher,
            creator: article.author,
            published_at: article.publishedAt,
            canonical_url: article.canonicalUrl,
            source_coverage: "text",
          }).eq("id", artifact.id).eq("user_id", input.userId);
          if (metadataUpdate.error) throw metadataUpdate.error;
          const receiptUpdate = await admin.from("source_receipts").update({
            canonical_url: article.receipt.canonicalUrl,
            source_title: article.receipt.title,
            publisher: article.receipt.publisher,
            retrieved_at: article.receipt.retrievedAt,
            coverage: article.receipt.coverage,
            content_hash: article.receipt.contentHash,
            provider_metadata: article.receipt.metadata,
          }).eq("artifact_id", artifact.id).eq("user_id", input.userId);
          if (receiptUpdate.error) throw receiptUpdate.error;
          modelInput = { ...modelInput, sourceCoverage: "text", normalizedText: article.text };
        }
      } catch {
        // Keep URL-only coverage when the public page is unavailable or unsafe.
      }
    }
    const extraction = await provider.extractArtifact(modelInput);
    const extractionRun = await admin.schema("private").from("model_runs").insert({
      user_id: input.userId,
      task_type: "artifact_extraction",
      provider: extraction.meta.provider,
      model: extraction.meta.model,
      prompt_version: extraction.meta.promptVersion,
      input_artifact_ids: [artifact.id],
      output_schema_version: extraction.meta.schemaVersion,
      latency_ms: extraction.meta.latencyMs,
      input_tokens: extraction.meta.inputTokens,
      output_tokens: extraction.meta.outputTokens,
      status: "succeeded",
      uncertainty_summary: extraction.value.uncertainties,
    }).select("id").single<{ id: string }>();
    if (extractionRun.error) throw extractionRun.error;

    // A retry may follow a failure after extraction but before the final response
    // is committed. Replace model-derived rows so retries cannot multiply memory
    // or retrieval evidence. Explicit user observations use different types and
    // are deliberately left untouched.
    const staleObservations = await admin.from("observations").delete()
      .eq("artifact_id", artifact.id).eq("user_id", input.userId).eq("observation_type", "source_content");
    if (staleObservations.error) throw staleObservations.error;
    const staleSegments = await admin.from("artifact_segments").delete()
      .eq("artifact_id", artifact.id).eq("user_id", input.userId).eq("metadata->>producer", "artifact-processing.v1");
    if (staleSegments.error) throw staleSegments.error;

    const existingSegmentsResult = await admin.from("artifact_segments")
      .select("id, segment_key, content_kind, text, start_offset, end_offset, start_seconds, end_seconds, speaker_label, speaker_relation, provenance_class, confidence")
      .eq("artifact_id", artifact.id).eq("user_id", input.userId);
    if (existingSegmentsResult.error) throw existingSegmentsResult.error;
    const evidenceSegments: SegmentRow[] = ((existingSegmentsResult.data ?? []) as Array<Record<string, unknown>>).map((row) => {
      const { id, ...segment } = row;
      return { id: String(id), ...evidenceSegmentSchema.parse(segment) };
    });
    if (artifact.user_note) {
      evidenceSegments.push({
        id: `pending:user-note:${artifact.id}`,
        ...evidenceSegmentSchema.parse({
          segment_key: "user-note",
          content_kind: "turn",
          text: artifact.user_note,
          speaker_relation: "user",
          provenance_class: "owner",
          confidence: 1,
        }),
      });
    }

    if (modelInput.normalizedText) {
      const chunks = Array.from({ length: Math.min(20, Math.ceil(modelInput.normalizedText.length / 6_000)) }, (_, index) => ({
        start: index * 6_000,
        end: Math.min(modelInput.normalizedText!.length, (index + 1) * 6_000),
        text: modelInput.normalizedText!.slice(index * 6_000, (index + 1) * 6_000),
      }));
      const embedded = [];
      for (const chunk of chunks) embedded.push({ ...chunk, result: await provider.embedText(chunk.text) });
      const embeddingRun = await admin.schema("private").from("model_runs").insert({
        user_id: input.userId, task_type: "embedding", provider: embedded[0]!.result.meta.provider,
        model: embedded[0]!.result.meta.model, prompt_version: embedded[0]!.result.meta.promptVersion,
        input_artifact_ids: [artifact.id], output_schema_version: embedded[0]!.result.meta.schemaVersion,
        latency_ms: embedded.reduce((sum, item) => sum + item.result.meta.latencyMs, 0),
        input_tokens: embedded.every((item) => item.result.meta.inputTokens !== null)
          ? embedded.reduce((sum, item) => sum + (item.result.meta.inputTokens ?? 0), 0) : null,
        output_tokens: 0, status: "succeeded", uncertainty_summary: [],
      });
      if (embeddingRun.error) throw embeddingRun.error;
      const segmentRows = embedded.map((item) => ({
        user_id: input.userId, artifact_id: artifact.id, segment_type: "normalized_text",
        segment_key: `processing:normalized:${item.start}`,
        content_kind: "normalized_text",
        start_offset: item.start, end_offset: item.end, text: item.text, embedding: item.result.value,
        speaker_relation: "source",
        provenance_class: artifact.provenance_class,
        confidence: 1,
        metadata: { coverage: modelInput.sourceCoverage, embedding_version: item.result.meta.schemaVersion, producer: "artifact-processing.v1" },
      }));
      const segment = await admin.from("artifact_segments").insert(segmentRows).select("id, segment_key");
      if (segment.error) throw segment.error;
      const insertedSegments = (segment.data ?? []) as Array<{ id: string; segment_key: string }>;
      for (const [index, row] of segmentRows.entries()) {
        evidenceSegments.push({
          id: insertedSegments[index]?.id ?? `pending:${row.segment_key}`,
          ...evidenceSegmentSchema.parse({
            segment_key: row.segment_key,
            content_kind: row.content_kind,
            text: row.text,
            start_offset: row.start_offset,
            end_offset: row.end_offset,
            speaker_relation: row.speaker_relation,
            provenance_class: row.provenance_class,
            confidence: row.confidence,
          }),
        });
      }
    }
    if (artifact.user_note) {
      const userNote = evidenceSegments.find((segment) => segment.segment_key === "user-note");
      if (userNote?.id.startsWith("pending:")) {
        const persistedNote = await admin.from("artifact_segments").insert({
          user_id: input.userId,
          artifact_id: artifact.id,
          segment_type: "user_note",
          segment_key: "user-note",
          content_kind: "turn",
          text: artifact.user_note,
          speaker_relation: "user",
          provenance_class: "owner",
          confidence: 1,
          metadata: { producer: "artifact-processing.v1", explicit_user_note: true },
        }).select("id").single<{ id: string }>();
        if (persistedNote.error) throw persistedNote.error;
        userNote.id = persistedNote.data.id;
      }
    }
    const observationRows = [
      { statement: extraction.value.source_summary, confidence: extraction.value.media_access_confidence },
      ...extraction.value.claims.map((statement) => ({ statement, confidence: Math.min(0.8, extraction.value.media_access_confidence) })),
    ].filter((item) => item.statement.trim().length > 0).slice(0, 12).map((item) => ({
      user_id: input.userId, artifact_id: artifact.id, observation_type: "source_content",
      statement: item.statement, scope: "what this artifact visibly or audibly contains",
      confidence: item.confidence, evidence_span: { coverage: modelInput.sourceCoverage }, model_run_id: extractionRun.data.id,
    }));
    if (observationRows.length > 0) {
      const observations = await admin.from("observations").insert(observationRows);
      if (observations.error) throw observations.error;
    }
    if (input.signalRefineryEnabled) {
      await compileAndPersistSignals(admin, {
        artifact,
        modelInput,
        segments: evidenceSegments.filter((segment) => !segment.id.startsWith("pending:")),
        provider,
      });
    }
    const immediate = await provider.generateImmediateResponse({
      ...modelInput,
      extraction: extraction.value,
      explicitRequest: classifyExplicitRequest(artifact.user_note),
    });
    const runInsert = await admin.schema("private").from("model_runs").insert({
      user_id: input.userId,
      task_type: "immediate_response",
      provider: immediate.meta.provider,
      model: immediate.meta.model,
      prompt_version: immediate.meta.promptVersion,
      input_artifact_ids: [artifact.id],
      output_schema_version: immediate.meta.schemaVersion,
      latency_ms: immediate.meta.latencyMs,
      input_tokens: immediate.meta.inputTokens,
      output_tokens: immediate.meta.outputTokens,
      status: "succeeded",
      uncertainty_summary: extraction.value.uncertainties,
    }).select("id").single<{ id: string }>();
    if (runInsert.error) throw runInsert.error;
    const responseInsert = await admin.from("artifact_responses").upsert({
      user_id: input.userId,
      artifact_id: artifact.id,
      mode: immediate.value.mode,
      response: immediate.value.response,
      why_question: immediate.value.why_question,
      suggested_actions: immediate.value.suggested_actions,
      confidence: immediate.value.confidence,
      model_run_id: runInsert.data.id,
    }, { onConflict: "artifact_id" });
    if (responseInsert.error) throw responseInsert.error;
    const updated = await admin.from("artifacts").update({ processing_status: "ready" }).eq("id", artifact.id).eq("user_id", input.userId);
    if (updated.error) throw updated.error;
    return { status: "ready", immediate: immediate.value };
  } catch (error) {
    await admin.from("artifacts").update({ processing_status: "failed_safe" }).eq("id", artifact.id).eq("user_id", input.userId);
    if (input.failForRetry) throw error;
    return {
      status: "failed_safe",
      immediate: immediateResponseSchema.parse({
        mode: "remember",
        response: "saved. i couldn’t analyze this yet.",
        why_question: null,
        suggested_actions: [],
        confidence: 1,
        should_wait_for_user: false,
      }),
    };
  }
}
