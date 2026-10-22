# Research synthesis — July 31, 2026

The current answer is not “pick one framework.” The useful convergence across current systems is:

1. Keep a small foreground loop and move slow enrichment, memory construction, and proactive deliberation into durable background work.
2. Make the event log canonical; treat summaries, memories, embeddings, and graphs as rebuildable projections.
3. Keep provider state optional. A runtime may use Responses conversations/compaction or Anthropic server compaction, but portable local state must remain sufficient to move providers.
4. Search/select tools rather than exposing an enormous tool list on every turn.
5. Apply approvals at the action boundary and preserve a resumable run, not merely a yes/no prompt.
6. Distinguish short fork/join delegation from durable multi-agent work.
7. Evaluate behavior as a product surface. Sycophancy, confident guessing, stale-memory reuse, interruption quality, and unauthorized action are regressions.

## Why not make a graph database the center?

Temporal knowledge graphs are useful when relationship traversal and changing facts matter. They are not enough for raw provenance, replay, job state, approvals, or causality. The runtime therefore starts with an append-only ledger and temporal memory projection. A graph is an optional read model fed from that ledger.

## Why no recursive self-modification loop?

The safe version of self-improvement is eval-driven configuration evolution: collect failures, propose a prompt/skill/router change, replay a fixed suite, compare outcomes and cost, and require review before promotion. Allowing a production agent to rewrite its own authority or evaluator creates an obvious reward-hacking path.

## Implementation consequences

- OpenAI Responses is used through an adapter with tool calls, explicit token limits, optional reasoning effort, `store=false` by default, and local conversation state.
- Anthropic Messages is used through the same runtime message model.
- MCP is the preferred integration boundary for external tool ecosystems; A2A is reserved for communication with independent remote agents, not internal child tasks.
- Prompt caching and compaction are optimizations, never memory correctness mechanisms.
- Video and long-content processing is queued, transcript-first, provenance-preserving, and allowed to stay silent when it finds nothing useful.

## Evidence behind the design

- OpenAI's current guidance distinguishes owning a custom Responses loop from using the Agents SDK for higher-level workflows; the runtime owns its loop so provider state remains optional. Responses supports local or provider-managed conversation state, background work, compaction, prompt caching, and MCP approvals, but none of those should become the only copy of memory. [Agents](https://developers.openai.com/api/docs/guides/agents), [conversation state](https://developers.openai.com/api/docs/guides/conversation-state), [MCP/connectors](https://developers.openai.com/api/docs/guides/tools-connectors-mcp)
- Anthropic's current agent guidance emphasizes tool search, programmatic tool use, prompt caching, and context editing/compaction as context-management tools. This supports selecting a small relevant tool set and keeping compaction separate from durable memory semantics. [Managing tool context](https://platform.claude.com/docs/en/agents-and-tools/tool-use/manage-tool-context)
- Current Anthropic model guidance lists Sonnet 5 as the speed/intelligence default, Opus 5 for complex agentic work, Fable 5 for the highest-capability long-running work, and Haiku 4.5 for cheap background tasks. Adaptive thinking plus `output_config.effort` is current on the 5-series. Defaults should remain configurable and be chosen by product-specific evals, not version-number reflex. [Models overview](https://platform.claude.com/docs/en/about-claude/models/overview), [effort](https://platform.claude.com/docs/en/build-with-claude/effort)
- The current MCP specification treats tool annotations as hints rather than a security boundary and puts human approval/visibility at the host boundary. The runtime therefore defaults unclassified MCP tools to external-write instead of trusting remote annotations. [MCP tools specification](https://modelcontextprotocol.io/specification/2025-11-25/server/tools)
- A2A is designed for communication with independent, potentially opaque remote agents. It is useful at an organizational boundary, but unnecessarily heavy for bounded child tasks sharing one runtime and ledger. [A2A v0.3.0](https://a2a-protocol.org/v0.3.0/specification/)
- LongMemEval-V2 expands memory evaluation beyond fact recall to changing information, workflows, temporal reasoning, and adversarial “gotchas.” Memora reports that memory systems often reuse invalidated information, while LazyMem argues for broad retrieval followed by selective query-time construction. Together they favor temporal correction chains and retrieved evidence over a single continuously rewritten biography. [LongMemEval-V2](https://arxiv.org/abs/2605.12493), [Memora](https://arxiv.org/abs/2604.20006), [LazyMem](https://arxiv.org/abs/2607.22690)
- OpenAI's sycophancy postmortem and Model Spec make clear that agreeableness is not fixed by one persona prompt: it needs training signals, behavioral policy, targeted evaluation, and user control. The runtime can improve the latter three; it cannot substitute for base-model training. [Sycophancy in GPT-4o](https://openai.com/index/sycophancy-in-gpt-4o/), [OpenAI Model Spec](https://model-spec.openai.com/2025-10-27)
- Graphiti provides a current temporal knowledge-graph implementation with provenance-aware episodes. That makes it a plausible optional projection, not a replacement for receipts, raw events, job state, or approvals. [Graphiti](https://github.com/getzep/graphiti)

## What this research does not prove

The 2026 memory papers are recent preprints, not a settled recipe for a personal co. Framework feature lists do not establish that a system has good judgment. The design is therefore deliberately falsifiable: behavior evals, interruption outcomes, stale-memory failures, unauthorized actions, latency, and cost must be measured on real longitudinal use. A graph projection, automated prompt evolution, or a different orchestration kernel should only be promoted when it beats this baseline on those measures.
