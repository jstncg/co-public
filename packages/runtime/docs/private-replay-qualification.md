# Private longitudinal replay qualification

The replay gate compares five systems on real, dated checkpoints without treating a green unit suite as product proof:

1. the candidate Co runtime with all pre-checkpoint history;
2. the response the live predecessor actually sent;
3. the candidate model with only the recent conversation;
4. a distinct fresh frontier model with only the recent conversation; and
5. a captured response from the strongest relevant external harness.

The corpus and every derived packet are private local artifacts. Commands print hashes, counts, dates, and paths only. They never print message content unless the operator explicitly requests replay `--details`.

## Prepare a source transcript without erasing it

The source may be a JSON array or JSONL sequence containing `role`, `content` or `text`, and an optional timestamp field (`timestamp`, `created_at`, `createdAt`, `date`, `observedAt`, or `ts`). Output is created with mode `0600` and exclusive-create semantics. The source is never changed, and an existing output is never overwritten.

```bash
npm start -- eval corpus prepare \
  --source /path/to/private-source.json \
  --out /path/to/new-private-corpus.jsonl
```

A timestamp with no `Z` or numeric UTC offset is ambiguous and fails closed. Supply the source's actual offset explicitly:

```bash
npm start -- eval corpus prepare \
  --source /path/to/private-source.json \
  --out /path/to/new-private-corpus.jsonl \
  --naive-offset -07:00
```

This produces normalized ISO timestamps while preserving turn order, content, and exchange grouping. The summary's source hash is the non-erasure receipt.

## Define cases

The manifest is JSON with `schemaVersion: 1`. Each case names a stable ID, one of the twelve product-eval families, a user checkpoint index, one or more earlier evidence indices, and a concrete grading rule. `useful-action` cases must also name every required outcome-producing tool in `requiredToolNames`.

Longitudinal `knownness`, `hidden-thesis`, `anti-recency`, `counterevidence`, and `subtle-reflection` cases require dated owner evidence from at least two calendar months. Assistant prose cannot satisfy that requirement. Every checkpoint must have the live assistant response from the same exchange so the predecessor comparison is real.

## Give an external harness the exact same case

Packet generation is an explicit private-data export. It writes each external case's complete pre-checkpoint history, checkpoint, and required tool names, plus an SHA-256 digest of that exact input:

```bash
npm start -- eval replay packet \
  --corpus /path/to/new-private-corpus.jsonl \
  --manifest /path/to/cases.json \
  --out /path/to/external-packet.json \
  --allow-private-export
```

The preferred capture path invokes an operator-selected runner directly, once per exact packet case, over JSON stdin. It never uses a shell, never prints runner stdout/stderr, hashes the runner executable, arguments, and configuration file, and creates rather than overwrites the baseline:

```bash
npm start -- eval replay capture \
  --corpus /path/to/new-private-corpus.jsonl \
  --manifest /path/to/cases.json \
  --out /path/to/external-results.json \
  --runner /absolute/path/to/runner \
  --runner-arg optional-fixed-argument \
  --runner-config /path/to/pinned-harness-config.json \
  --harness OpenClaw \
  --harness-version pinned-version-or-commit \
  --allow-private-model-upload
```

For each invocation, the runner receives `{protocol, configurationPath, configurationDigest, case}` and must return exactly one JSON object shaped as `{protocol:"co.external-replay.v1", response:string, receipts:[]}`. It must run the actual external harness with the supplied pre-checkpoint history; wrapping a plain model prompt and labeling it OpenClaw or Hermes is not a valid comparison.

### Pinned OpenClaw adapter

The repository ships a typechecked adapter for OpenClaw's real `agent exec` interface. First create a dedicated OpenClaw configuration and empty state/workspace directories. The OpenClaw configuration should explicitly select the provider/model and the smallest tool policy appropriate to the comparison; do not use an ambient personal configuration. Then pin the exact executable surface into a new, mode-`0600` runner configuration:

```bash
npm start -- eval replay openclaw-config \
  --out /private/new-openclaw-runner.json \
  --command /absolute/path/to/node \
  --command-arg /absolute/path/to/openclaw/openclaw.mjs \
  --launcher-cwd /absolute/path/to/openclaw \
  --repo /absolute/path/to/openclaw \
  --openclaw-config /private/openclaw-eval.json \
  --openclaw-state /private/empty-openclaw-state \
  --agent-cwd /private/empty-openclaw-workspace \
  --model openai/gpt-5.6-sol \
  --thinking high \
  --runtime-evidence /absolute/path/to/openclaw/node_modules/@openai
```

Pinning probes `agent exec --help`, requires `--message-file`, `--config`, `--cwd`, and `--json`, and refuses a dirty checkout. The resulting file binds the full commit, launcher executable, command-argument files, OpenClaw configuration, built `dist` tree, package and lock metadata, and any extra `--runtime-evidence` paths. Explicit evidence paths must exist and may not contain symbolic links. Include the installed SDK/CLI package for the chosen agent runtime, as above, because a lockfile alone does not prove installed bytes. The adapter checks all boundaries both before and after every case. Prior pin files are historical evidence; create a new filename after any source, build, dependency, configuration, or executable change.

Capture with Node as the runner and the shipped adapter as its fixed argument:

```bash
npm start -- eval replay capture \
  --corpus /private/corpus.jsonl \
  --manifest /private/cases.json \
  --out /private/new-openclaw-results.json \
  --runner /absolute/path/to/node \
  --runner-arg /absolute/path/to/agent-runtime/src/openclaw-replay-runner.ts \
  --runner-config /private/new-openclaw-runner.json \
  --harness OpenClaw \
  --harness-version pinned-full-commit \
  --allow-private-model-upload
```

The outer capture also content-hashes regular files named in the fixed argument list, so changing the TypeScript adapter invalidates provenance. Each OpenClaw case is an isolated real harness turn receiving the exact prior history as quoted JSON evidence; it does not claim to reconstruct months of native OpenClaw session storage. OpenClaw's generic tool summary proves only that calls occurred, not that an external outcome happened, so this adapter deliberately returns no semantic receipts. A `useful-action` comparison therefore needs a separately reviewed adapter that converts real domain outcome evidence into the strict receipt schema below; fabricating receipts from `toolSummary` is invalid.

The resulting baseline uses schema version 2:

```json
{
  "schemaVersion": 2,
  "harness": {
    "name": "OpenClaw",
    "version": "pinned-version-or-commit",
    "configurationDigest": "64 lowercase hex characters"
  },
  "capture": {
    "protocol": "co.external-replay.v1",
    "runnerSha256": "sha256 of the exact runner executable",
    "argumentsSha256": "sha256 of the fixed argument array and regular-file argument contents"
  },
  "corpusSha256": "copied from the packet",
  "manifestSha256": "copied from the packet",
  "packetSha256": "sha256 of the compact canonical packet JSON",
  "generatedAt": "2026-09-04T00:00:00.000Z",
  "cases": [
    {
      "id": "case-id",
      "inputSha256": "copied from that packet case",
      "invocationSha256": "digest binding runner, config, input, response, and receipts",
      "response": "the external harness response",
      "receipts": []
    }
  ]
}
```

For an action case, a real external-harness semantic receipt is represented without its potentially private body:

```json
{
  "receiptId": "external-receipt-id",
  "toolName": "artifact.prepare",
  "status": "succeeded",
  "effectState": "confirmed",
  "evidenceScope": "outcome",
  "outputSha256": "sha256 of the external receipt output"
}
```

The evaluator rejects legacy baselines, unknown or missing cases, stale packet/input hashes, changed post-capture responses or receipts, duplicate receipt IDs, and anything weaker than a confirmed semantic outcome receipt before it calls any private model. On action cases, logged, frontier, ablated, and external responses all fail the behavioral rule if they lack the exact required receipts; eloquent completion prose cannot beat receipt-backed work.

## Run the blind comparison

```bash
npm start -- eval replay \
  --corpus /path/to/new-private-corpus.jsonl \
  --manifest /path/to/cases.json \
  --external-baseline /path/to/external-results.json \
  --allow-private-model-upload
```

The ordinary report contains scores, winners, action-proof state, and response/reason hashes. It withholds raw responses and the judge's free-text rationale because either can quote private history. `--details` is an explicit local diagnostic that includes them.

A completed replay is still not automatic release approval. Promotion requires the targets in `goal.md`, a human check that the selected cases represent the longitudinal product, and a recorded decision against the exact release digest.
