import OpenAI from "openai";
import { webSearchResultSchema, type WebCitation, type WebSearchResult } from "@co/contracts";
import { webSearchPrompt } from "@co/prompts";
import { compileSanitizedSearchQuery, type SearchSignal } from "@co/source-adapters";

type ResponsesClient = Pick<OpenAI, "responses">;

export class OpenAIWebSearchProvider {
  private readonly client: ResponsesClient;

  constructor(
    options: { apiKey?: string; model: string; client?: ResponsesClient },
  ) {
    this.client = options.client ?? new OpenAI({ apiKey: options.apiKey });
    this.model = options.model;
  }

  private readonly model: string;

  async search(signals: SearchSignal[]): Promise<WebSearchResult> {
    const query = compileSanitizedSearchQuery(signals);
    const response = await this.client.responses.create({
      model: this.model,
      store: false,
      tools: [{ type: "web_search" }],
      include: ["web_search_call.action.sources"],
      input: [
        { role: "system", content: webSearchPrompt },
        { role: "user", content: query },
      ],
    });
    const summary = response.output_text.trim();
    const citations = extractCitations(response.output);
    return webSearchResultSchema.parse({ query, summary, citations });
  }
}

function extractCitations(output: unknown): WebCitation[] {
  const found: WebCitation[] = [];
  const visit = (value: unknown) => {
    if (Array.isArray(value)) { value.forEach(visit); return; }
    if (!value || typeof value !== "object") return;
    const record = value as Record<string, unknown>;
    if (record.type === "url_citation" && typeof record.url === "string") {
      found.push({
        url: record.url,
        title: typeof record.title === "string" && record.title ? record.title : new URL(record.url).hostname,
        startIndex: typeof record.start_index === "number" ? record.start_index : 0,
        endIndex: typeof record.end_index === "number" ? record.end_index : 0,
      });
    }
    Object.values(record).forEach(visit);
  };
  visit(output);
  return [...new Map(found.map((citation) => [`${citation.url}:${citation.startIndex}:${citation.endIndex}`, citation])).values()];
}
