import { describe, expect, it, vi } from "vitest";
import { OpenAIWebSearchProvider } from "../src/index";

describe("OpenAI web-search boundary", () => {
  it("sends only the compiled query, disables storage, and preserves clickable citations", async () => {
    const create = vi.fn(async (_input: unknown) => ({
      output_text: "Applications close Friday.",
      output: [{ type: "message", content: [{ type: "output_text", text: "Applications close Friday.", annotations: [{ type: "url_citation", url: "https://official.example/apply", title: "Official applications", start_index: 0, end_index: 26 }] }] }],
    }));
    const provider = new OpenAIWebSearchProvider({ model: "gpt-5.6-luna", client: { responses: { create } } as any });
    const result = await provider.search([{ kind: "entity", value: "Official Room" }, { kind: "topic", value: "applications" }]);
    expect(create).toHaveBeenCalledWith(expect.objectContaining({ store: false, tools: [{ type: "web_search" }] }));
    expect(JSON.stringify(create.mock.calls[0]?.[0])).not.toContain("private history");
    expect(result.citations[0]?.url).toBe("https://official.example/apply");
  });

  it("fails closed when a factual search has no URL citations", async () => {
    const create = vi.fn(async (_input: unknown) => ({ output_text: "An unsupported claim", output: [] }));
    const provider = new OpenAIWebSearchProvider({ model: "gpt-5.6-luna", client: { responses: { create } } as any });
    await expect(provider.search([{ kind: "topic", value: "systems thinking" }])).rejects.toThrow();
  });
});
