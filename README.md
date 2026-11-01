# curt-convert

Convert Claude Code session transcripts (`.jsonl`) into
[`.curt`](https://github.com/JordanNewell/dot_curt) single-file conversation
format. Built on [`curt-format`](https://www.npmjs.com/package/curt-format)
(reference implementation, v1 core).

> **Warning: output is transcript-equivalent.** Conversion is faithful, not
> redacting: if the transcript contains secrets (API keys, tokens, hostnames,
> private paths, unreleased code), the `.curt` file contains them too. Do not
> share, commit, or publish `.curt` output without scrubbing it first. The
> fixtures in `test/fixtures/` are fully synthetic; no real transcript content
> is committed to this repo.

```sh
npm install -g curt-convert   # or: npx curt-convert
curt-convert C:/Users/you/.claude/projects/C--tmp-demo/abc-123.jsonl
curt-convert C:/Users/you/.claude/projects/C--tmp-demo/ -o ./out
curt-convert "**/*.jsonl" -o ./out
curt-convert session.jsonl --stdout > session.curt
```

- A `.jsonl` file, a directory (walked recursively), or a glob all work.
- Output defaults to alongside each input; `-o/--out` redirects to a directory.
- Output file names follow the Curtis bulk convention
  (`YYYY-MM-DD <slug> <suffix>.curt`) via `curtFilename()`.
- Bulk runs never overwrite: when two inputs produce the same output name
  (parent sessions and their sidechain files share a `sessionId`), later
  inputs get a deterministic `-<6 hex>` suffix derived from the source file
  path — stable across runs, no randomness.
- Every file is re-parsed with `parseCurt` before it is written; a file that
  fails round-trip validation is never written (set `CURT_CONVERT_SELFCHECK=0`
  to skip).

## Mapping

| Claude Code JSONL | .curt | Notes |
|---|---|---|
| `sessionId` | `conversation.id` | Falls back to the file stem. |
| `ai-title` line `aiTitle` | `conversation.title` | Last one wins; otherwise first user text (<= 60 chars). |
| first/last kept message `timestamp` | `conversation.createdAt` / `updatedAt` | ISO 8601 -> epoch milliseconds. |
| `"model"` on assistant messages | `conversation.model` + per-message `model` | Most frequent model wins at conversation level. |
| — | `conversation.provider` | Always `"anthropic"`. |
| `cwd`, `gitBranch`, `version` | `conversation.cwd` / `gitBranch` / `claudeCodeVersion` | Extra fields; readers ignore unknowns. |
| entry `type: "user"`, string `message.content` | message `{ role: "user" }` | `<system-reminder>...</system-reminder>` spans are stripped (harness-injected, not user content). |
| `message.content[]` block `type: "text"` | `content` (blocks joined with `\n\n`) | On user and assistant messages. |
| `message.content[]` block `type: "tool_use"` (`id`, `name`, `input`) | `message.toolCalls[] = { id, name, arguments }` | Declares the `tool-linkage` extension on the conversation. |
| `message.content[]` block `type: "tool_result"` (`tool_use_id`, `content`) | separate message `{ role: "tool", toolCallId }` | Text content lands in `content`; per `tool-linkage`, `toolCallId` references `toolCalls[].id`. |
| tool_result non-text blocks (images, ...) | message extra field `nonTextContent` | Structured passthrough; the base64 payload survives verbatim. |
| tool_result `is_error: true` | message extra field `isError: true` | |
| `type: "assistant"`, `thinking` blocks | message extra field `thinking` | Kept out of `content` (model-internal); opaque `signature` dropped. |
| `server_tool_use` blocks (web search) | mapped into `toolCalls` like any call | Results for these often have no `tool_use_id` result line; counted as unlinked. |
| entry `uuid` | message `id` | Synthesized `"<file-stem>-<n>"` when absent. |
| `isSidechain: true` (subagent turns) | message extra field `isSidechain: true` | Kept, flagged — not dropped. |
| `isApiErrorMessage: true` | dropped | Failed API calls are not conversation. |
| `isMeta: true`, `isVisibleInTranscriptOnly` | dropped | Caveat banners and transcript-only echoes. |

Lines with any other `type` are noise and dropped: `summary`, `system`,
`attachment`, `queue-operation`, `ai-title` (read for the title, then dropped),
`mode`, `permission-mode`, `cost-state`, `file-history-snapshot`,
`file-history-delta`, `agent-setting`, `atis-latch`, `last-prompt`,
`agent-name`, `api-request*`, `pr-link`, `fork-context-ref`, `started`,
`result`, `failed`, `launched`, `continued-in`, and anything unrecognized.
Unparseable lines are counted in stats, never fatal. User/assistant entries
that end up with no content at all (whitespace-only text, reminder-only user
turns, assistant entries with empty block arrays) are skipped too and counted
as meta, not conversation.

## Documented losses

- Token counts and cost (`message.usage`, `cost-state` lines) — dropped.
- `toolUseResult` on user entries — a client-side debug mirror of tool output,
  not the wire payload; dropped (the `tool_result` block is the source).
- Thinking block `signature` (opaque verifier) — dropped; the thinking *text*
  is kept on the message.
- `parentUuid` / `sourceToolAssistantUUID` chain — dropped; ordering is the
  JSONL line order, and call/result linkage rides `tool-linkage` ids instead.
- `<system-reminder>` spans inside user text — stripped as harness chatter.
- Summaries, attachments, file-history snapshots, PR links, cost state —
  these lines have no `.curt` counterpart and are dropped entirely.
- Envelope-top-level extras beyond `curt`/`version`/`generator`/
  `conversation` are not carried from a *read* `.curt` file (this tool only
  writes). Unknown fields inside the conversation and its messages are
  preserved where possible by conforming readers, but preservation is not
  guaranteed normatively by the spec.

## The `tool-linkage` extension

When the transcript contains any tool calls, the output declares
`extensions: ["tool-linkage"]` and uses its field contract: assistant messages
carry `toolCalls[] = { id, name, arguments }`, and each tool result is its own
`role: "tool"` message with `toolCallId` referencing `toolCalls[].id`.
Readers that do not know the extension ignore these fields; the v1 core
still validates.

## Security

See the warning at the top of this README: `.curt` output is
transcript-equivalent. Conversion adds nothing and removes only harness
chatter (`<system-reminder>` spans, meta/noise lines) — everything else in
the conversation, including anything sensitive that was in the session,
survives verbatim. Scrub before sharing.

## Development

```sh
npm i
npm test       # vitest, 30 tests
npm run build  # tsc -> dist/
```

## Part of the .curt suite

- [`curt-format`](https://github.com/JordanNewell/dot_curt) — the .curt format spec + reference implementation ([npm](https://www.npmjs.com/package/curt-format))
- [`curt-convert`](https://github.com/JordanNewell/curt-convert) — Claude Code transcripts → .curt ([npm](https://www.npmjs.com/package/curt-convert))
- [`curt-vcon`](https://github.com/JordanNewell/curt-vcon) — .curt ⇄ vCon (IETF) bridge ([npm](https://www.npmjs.com/package/curt-vcon))
- [`curt-wildchat`](https://github.com/JordanNewell/curt-wildchat) — WildChat-1M records → .curt ([npm](https://www.npmjs.com/package/curt-wildchat))
- [`curt-openwith`](https://github.com/JordanNewell/curt-openwith) — double-click any .curt file: offline viewer, Windows + macOS + Linux

MIT — see [LICENSE](LICENSE).
