import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

const server = new McpServer({ name: "co-test", version: "1.0.0" });
server.registerTool("remote-ping", {
  description: "Return a deterministic response from a remote test server.",
  annotations: { readOnlyHint: true, idempotentHint: true },
}, async () => ({ content: [{ type: "text", text: "pong" }], structuredContent: { answer: "pong" } }));
server.registerTool("remote-error", {
  description: "Simulate a tool that may have mutated before reporting an error.",
}, async () => ({ isError: true, content: [{ type: "text", text: "remote failure after dispatch" }] }));

await server.connect(new StdioServerTransport());
