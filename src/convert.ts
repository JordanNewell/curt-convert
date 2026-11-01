/**
 * Convert Claude Code session transcripts (JSONL) to .curt conversations.
 *
 * Observed JSONL schema (Claude Code ~1.x–2.x, corpus of 1167 sessions):
 * - Line types kept: `user`, `assistant` (conversation turns).
 * - Line types treated as noise and dropped: `summary`, `system`,
 *   `attachment`, `queue-operation`, `ai-title`, `mode`, `permission-mode`,
 *   `cost-state`, `file-history-snapshot`, `file-history-delta`,
 *   `agent-setting`, `atis-latch`, `last-prompt`, `agent-name`,
 *   `api-request*`, `pr-link`, `fork-context-ref`, `started`, `result`,
 *   `failed`, `launched`, `continued-in`, and anything unrecognized.
 * - `user` entries: `message.content` is a plain string, or a block array of
 *   `text` / `tool_result` blocks. Noise flags: `isMeta: true`,
 *   `isVisibleInTranscriptOnly`. `toolUseResult` is a debug mirror of the
 *   tool output (not the wire payload) and is not used.
 * - `assistant` entries: `message.content` is a block array of `text`,
 *   `thinking` (`thinking` + opaque `signature`), `tool_use` (`id`, `name`,
 *   `input`), rarely `server_tool_use`, rarely `tool_result`.
 *   `message.usage` carries token counts (dropped).
 */

import {
	type CurtConversation,
	type CurtMessage,
	serializeCurt,
} from "curt-format";

export const GENERATOR = "curt-convert@0.1.0";

/** Extension used to link tool calls to their results (see EXTENSIONS.md). */
export const TOOL_LINKAGE = "tool-linkage";

export interface ConvertStats {
	/** Conversation turns and tool-result messages emitted. */
	messages: number;
	toolCalls: number;
	toolResults: number;
	/** tool_result blocks with no matching tool_use id in any prior call. */
	unlinkedToolResults: number;
	/** Lines dropped because of their `type` (summaries, attachments, ...). */
	skippedNoise: number;
	/** user/assistant lines dropped (`isMeta`, API errors, empty content). */
	skippedMeta: number;
	/** Lines that failed JSON.parse. */
	parseErrors: number;
}

export interface ConvertResult {
	conversation: CurtConversation;
	stats: ConvertStats;
}

interface JsonlEntry {
	type?: unknown;
	uuid?: unknown;
	timestamp?: unknown;
	sessionId?: unknown;
	cwd?: unknown;
	gitBranch?: unknown;
	version?: unknown;
	isMeta?: unknown;
	isSidechain?: unknown;
	isApiErrorMessage?: unknown;
	isVisibleInTranscriptOnly?: unknown;
	message?: unknown;
	aiTitle?: unknown;
}

interface Block {
	type?: unknown;
	text?: unknown;
	thinking?: unknown;
	id?: unknown;
	name?: unknown;
	input?: unknown;
	tool_use_id?: unknown;
	content?: unknown;
	isError?: unknown;
	[key: string]: unknown;
}

function isObj(v: unknown): v is Record<string, unknown> {
	return typeof v === "object" && v !== null && !Array.isArray(v);
}

function asString(v: unknown): string | undefined {
	return typeof v === "string" ? v : undefined;
}

/** ISO timestamp -> epoch ms; 0 when missing/unparseable. */
export function parseTimestamp(v: unknown): number {
	if (typeof v !== "string") return 0;
	const ms = Date.parse(v);
	return Number.isFinite(ms) ? ms : 0;
}

/**
 * Claude Code injects harness chatter into user text via
 * `<system-reminder>...</system-reminder>` spans. These are not user
 * content; strip them (documented loss).
 */
export function stripSystemReminders(text: string): string {
	return text.replace(
		/<system-reminder>[\s\S]*?<\/system-reminder>/g,
		"",
	).trim();
}

/** Extract plain text from a tool_result `content` (string or block array). */
function toolResultText(content: unknown): { text: string; nonText: Block[] } {
	if (typeof content === "string") return { text: content, nonText: [] };
	if (Array.isArray(content)) {
		const nonText: Block[] = [];
		const parts: string[] = [];
		for (const b of content) {
			if (typeof b === "string") {
				parts.push(b);
			} else if (isObj(b) && b.type === "text" && typeof b.text === "string") {
				parts.push(b.text);
			} else if (isObj(b)) {
				nonText.push(b as Block);
			}
		}
		return { text: parts.join("\n"), nonText };
	}
	return { text: "", nonText: [] };
}

function titleFrom(text: string): string {
	const flat = text.replace(/\s+/g, " ").trim();
	return flat.length > 60 ? `${flat.slice(0, 57)}...` : flat;
}

function mode<T>(values: T[]): T | undefined {
	const counts = new Map<T, number>();
	for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
	let best: T | undefined;
	let n = 0;
	for (const [v, c] of counts) {
		if (c > n) {
			best = v;
			n = c;
		}
	}
	return best;
}

/**
 * Convert one JSONL transcript body into a .curt conversation.
 * `fallbackId` is used when the transcript carries no `sessionId`.
 */
export function convertTranscript(raw: string, fallbackId = "session"): ConvertResult {
	const stats: ConvertStats = {
		messages: 0,
		toolCalls: 0,
		toolResults: 0,
		unlinkedToolResults: 0,
		skippedNoise: 0,
		skippedMeta: 0,
		parseErrors: 0,
	};

	const messages: CurtMessage[] = [];
	let sessionId: string | undefined;
	let title: string | undefined;
	let firstUserText: string | undefined;
	let cwd: string | undefined;
	let gitBranch: string | undefined;
	let cliVersion: string | undefined;
	const models: string[] = [];
	const toolCallIds = new Set<string>();

	const lines = raw.split(/\r?\n/);
	for (const line of lines) {
		if (!line.trim()) continue;
		let entry: JsonlEntry;
		try {
			entry = JSON.parse(line) as JsonlEntry;
		} catch {
			stats.parseErrors++;
			continue;
		}

		if (!isObj(entry)) {
			stats.skippedNoise++;
			continue;
		}
		if (typeof entry.aiTitle === "string") {
			title = entry.aiTitle;
		}

		const type = asString(entry.type);
		if (type !== "user" && type !== "assistant") {
			stats.skippedNoise++;
			continue;
		}
		if (entry.isMeta === true || entry.isVisibleInTranscriptOnly === true) {
			stats.skippedMeta++;
			continue;
		}
		if (type === "assistant" && entry.isApiErrorMessage === true) {
			stats.skippedMeta++;
			continue;
		}

		if (!sessionId && typeof entry.sessionId === "string") {
			sessionId = entry.sessionId;
		}
		if (!cwd && typeof entry.cwd === "string") cwd = entry.cwd;
		if (!gitBranch && typeof entry.gitBranch === "string") {
			gitBranch = entry.gitBranch;
		}
		if (!cliVersion && typeof entry.version === "string") {
			cliVersion = entry.version;
		}

		const timestamp = parseTimestamp(entry.timestamp);
		const id = typeof entry.uuid === "string" ? entry.uuid : `${fallbackId}-${messages.length}`;
		const message = (isObj(entry.message) ? entry.message : {}) as {
			role?: unknown;
			model?: unknown;
			content?: unknown;
		};

		if (type === "assistant") {
			if (typeof message.model === "string" && message.model) {
				models.push(message.model);
			}
			const blocks: Block[] = Array.isArray(message.content)
				? (message.content as Block[])
				: [];
			const text: string[] = [];
			const thinking: string[] = [];
			const toolCalls: { id: string; name: string; arguments: unknown }[] = [];
			for (const b of blocks) {
				if (!isObj(b)) continue;
				if (b.type === "text" && typeof b.text === "string") {
					text.push(b.text);
				} else if (b.type === "thinking" && typeof b.thinking === "string") {
					thinking.push(b.thinking);
				} else if (
					(b.type === "tool_use" || b.type === "server_tool_use") &&
					typeof b.id === "string" &&
					typeof b.name === "string"
				) {
					toolCalls.push({ id: b.id, name: b.name, arguments: b.input ?? null });
					toolCallIds.add(b.id);
				}
				// Assistant-side `tool_result` blocks (rare, seen on retries):
				// kept out; the user-side copy is the canonical result.
			}
			if (text.length === 0 && thinking.length === 0 && toolCalls.length === 0) {
				stats.skippedMeta++;
				continue;
			}
			const msg: CurtMessage = {
				id,
				role: "assistant",
				content: text.join("\n\n"),
				timestamp,
			};
			if (typeof message.model === "string" && message.model) {
				msg.model = message.model;
			}
			if (thinking.length > 0) msg.thinking = thinking.join("\n\n");
			if (toolCalls.length > 0) msg.toolCalls = toolCalls;
			if (entry.isSidechain === true) msg.isSidechain = true;
			messages.push(msg);
			stats.toolCalls += toolCalls.length;
			continue;
		}

		// --- user entry ---
		const content = message.content;
		if (typeof content === "string") {
			const cleaned = stripSystemReminders(content);
			if (!cleaned) {
				stats.skippedMeta++;
				continue;
			}
			messages.push({ id, role: "user", content: cleaned, timestamp });
			firstUserText ??= cleaned;
			continue;
		}
		if (!Array.isArray(content)) {
			stats.skippedMeta++;
			continue;
		}
		const userText: string[] = [];
		let emittedToolResult = false;
		for (const b of content as Block[]) {
			if (!isObj(b)) continue;
			if (b.type === "text" && typeof b.text === "string") {
				userText.push(b.text);
			} else if (b.type === "tool_result") {
				const callId = asString(b.tool_use_id);
				const { text, nonText } = toolResultText(b.content);
				const toolMsg: CurtMessage = {
					id: `${id}-tool`,
					role: "tool",
					content: text,
					timestamp,
					toolCallId: callId ?? "",
				};
				if (b.isError === true) toolMsg.isError = true;
				if (nonText.length > 0) {
					toolMsg.nonTextContent = nonText;
				}
				messages.push(toolMsg);
				stats.toolResults++;
				if (callId && toolCallIds.has(callId)) {
					// linked
				} else {
					stats.unlinkedToolResults++;
				}
				emittedToolResult = true;
			}
		}
		const userContent = userText.join("\n\n").trim();
		if (userContent) {
			messages.push({ id, role: "user", content: userContent, timestamp });
			firstUserText ??= userContent;
		} else if (!emittedToolResult) {
			stats.skippedMeta++;
		}
	}

	const usedToolLinkage = stats.toolCalls > 0;
	if (usedToolLinkage) {
		stats.unlinkedToolResults = messages.filter(
			(m) => m.role === "tool" && !(typeof m.toolCallId === "string" && toolCallIds.has(m.toolCallId)),
		).length;
	}

	const first = messages[0];
	const last = messages[messages.length - 1];
	const fallbackTitle = firstUserText ? titleFrom(firstUserText) : "";
	const conversation: CurtConversation = {
		id: sessionId ?? fallbackId,
		title: title ?? fallbackTitle,
		createdAt: first?.timestamp ?? 0,
		updatedAt: last?.timestamp ?? 0,
		messages,
		provider: "anthropic",
	};
	const conversationModel = mode(models);
	if (conversationModel) conversation.model = conversationModel;
	if (cwd) conversation.cwd = cwd;
	if (gitBranch) conversation.gitBranch = gitBranch;
	if (cliVersion) conversation.claudeCodeVersion = cliVersion;
	if (usedToolLinkage) conversation.extensions = [TOOL_LINKAGE];

	stats.messages = messages.length;
	return { conversation, stats };
}

/** Serialize a converted conversation as a complete .curt file body. */
export function serializeResult(result: ConvertResult): string {
	return serializeCurt(
		result.conversation,
		GENERATOR,
		result.conversation.extensions as string[] | undefined,
	);
}
