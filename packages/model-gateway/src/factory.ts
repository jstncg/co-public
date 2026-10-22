import { MockModelProvider } from "./mock-model-provider";
import { OpenAIModelProvider } from "./openai-model-provider";
import type { ModelProvider } from "./types";

export function createModelProvider(environment: Record<string, string | undefined> = process.env): ModelProvider {
  if (!environment.OPENAI_API_KEY) return new MockModelProvider();
  return new OpenAIModelProvider({
    apiKey: environment.OPENAI_API_KEY,
    fastModel: environment.MODEL_FAST ?? "gpt-4o-mini",
    visionModel: environment.MODEL_VISION ?? "gpt-4o-mini",
    transcriptionModel: environment.MODEL_TRANSCRIPTION ?? "gpt-4o-mini-transcribe",
    embeddingModel: environment.MODEL_EMBEDDING ?? "text-embedding-3-small",
  });
}
