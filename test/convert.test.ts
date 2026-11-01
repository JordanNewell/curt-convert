import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { parseCurt, serializeCurt } from "curt-format";
import {
	convertTranscript,
	parseTimestamp,
	resolveOutputName,
	serializeResult,
	stripSystemReminders,
} from "../src/convert.js";

const fx = (name: string) =>
	readFileSync(join(import.meta.dirname, "fixtures", name), "utf8");

describe("stripSystemReminders", () => {
	it("drops reminder spans and trims", () => {
		expect(
			stripSystemReminders("hello\n<system-reminder>junk</system-reminder>"),
		).toBe("hello");
	});
	it("returns empty when only a reminder remains", () => {
		expect(stripSystemReminders("<system-reminder>junk</system-reminder>")).toBe("");
	});
});

describe("convertTranscript: basic fixture", () => {
	const { conversation, stats } = convertTranscript(fx("basic.jsonl"), "session-basic");

	it("keeps only conversation turns", () => {
		// user, assistant, assistant(tool_use), tool, assistant, user, assistant
		expect(conversation.messages.map((m) => m.role)).toEqual([
			"user",
			"assistant",
			"assistant",
			"tool",
			"assistant",
			"user",
			"assistant",
		]);
	});

	it("drops summary/attachment/isMeta/system/queue/cost noise lines", () => {
		expect(stats.skippedNoise).toBeGreaterThanOrEqual(6);
		expect(stats.skippedMeta).toBeGreaterThanOrEqual(1);
		expect(conversation.messages.some((m) => m.content.includes("Caveat:"))).toBe(false);
		expect(conversation.messages.some((m) => m.content.includes("Session compacted"))).toBe(false);
	});

	it("extracts the ai-title when present", () => {
		expect(conversation.title).toBe("Widget refactor planning");
	});

	it("carries tool_use as tool-linkage toolCalls", () => {
		const call = conversation.messages[2];
		expect(Array.isArray(call.toolCalls)).toBe(true);
		expect((call.toolCalls as { id: string; name: string }[])[0].name).toBe("Glob");
		expect(conversation.extensions).toEqual(["tool-linkage"]);
	});

	it("links tool results to their call ids", () => {
		const result = conversation.messages[3];
		expect(result.role).toBe("tool");
		expect(result.toolCallId).toBe("toolu_000000000000000000000001");
		expect(result.content).toBe("widget-a.ts\nwidget-b.ts");
		expect(stats.unlinkedToolResults).toBe(0);
	});

	it("keeps thinking out of content but on the message", () => {
		const a = conversation.messages[1];
		expect(a.content).toBe("I'll start by listing the widget files.");
		expect(a.thinking).toBe("The widget module needs a plan.");
	});

	it("strips system-reminder blocks from user text", () => {
		const u = conversation.messages[5];
		expect(u.content).toBe("Yes, rename widget-a to widget-alpha.");
	});

	it("records model, provider, session metadata", () => {
		expect(conversation.provider).toBe("anthropic");
		expect(conversation.model).toBe("claude-fake-model");
		expect(conversation.cwd).toBe("C:/tmp/demo");
		expect(conversation.gitBranch).toBe("main");
		expect(conversation.claudeCodeVersion).toBe("1.0.100");
		expect(conversation.id).toBe("session-basic");
	});

	it("uses ISO timestamps as epoch ms", () => {
		expect(conversation.createdAt).toBe(Date.parse("2026-10-01T10:00:00.000Z"));
		expect(conversation.updatedAt).toBe(Date.parse("2026-10-01T10:01:05.000Z"));
	});
});

describe("convertTranscript: tool-linkage fixture", () => {
	const { conversation, stats } = convertTranscript(fx("tool-linkage.jsonl"), "session-tools");

	it("emits one tool message per result, in order", () => {
		const tools = conversation.messages.filter((m) => m.role === "tool");
		expect(tools.map((m) => m.toolCallId)).toEqual([
			"toolu_100000000000000000000001",
			"toolu_100000000000000000000002",
			"toolu_100000000000000000000003",
		]);
		expect(stats.toolCalls).toBe(3);
		expect(stats.toolResults).toBe(3);
	});

	it("keeps text and tool calls on the same assistant message", () => {
		const a = conversation.messages.find((m) => m.content.startsWith("Tests pass"));
		expect(a?.toolCalls).toHaveLength(1);
	});

	it("maps tool_use inputs verbatim into arguments", () => {
		const edit = conversation.messages
			.flatMap((m) => (m.toolCalls as { name: string; arguments: unknown }[] | undefined) ?? [])
			.find((c) => c.name === "Edit");
		expect(edit?.arguments).toEqual({
			file_path: "E:/demo/fake-config.json",
			old_string: "true",
			new_string: "false",
		});
	});
});

describe("convertTranscript: edge-cases fixture", () => {
	const { conversation, stats } = convertTranscript(fx("edge-cases.jsonl"), "session-edge");

	it("flags sidechain (subagent) messages instead of dropping them", () => {
		const side = conversation.messages.find((m) => m.content.includes("Subagent analysis"));
		expect(side?.isSidechain).toBe(true);
	});

	it("drops API-error assistant entries", () => {
		expect(conversation.messages.some((m) => m.content.includes("API Error"))).toBe(false);
	});

	it("counts unlinked tool results after compaction", () => {
		expect(stats.unlinkedToolResults).toBe(1);
	});

	it("counts parse errors on malformed lines", () => {
		expect(stats.parseErrors).toBe(1);
	});

	it("preserves non-text tool_result payloads as passthrough", () => {
		const tool = conversation.messages.find((m) => m.role === "tool");
		expect(tool?.nonTextContent).toEqual([
			{ type: "image", source: { type: "base64", media_type: "image/png", data: "ZmFrZQ==" } },
		]);
		expect(tool?.content).toBe("");
	});

	it("drops whitespace-only user turns and reminder-only turns", () => {
		expect(
			conversation.messages
				.filter((m) => m.role === "user")
				.every((m) => (m.content as string).trim().length > 0),
		).toBe(true);
	});
});

describe("round-trip through parseCurt", () => {
	for (const name of ["basic.jsonl", "tool-linkage.jsonl", "edge-cases.jsonl"]) {
		it(`serializes ${name} to a valid .curt body`, () => {
			const { conversation } = convertTranscript(fx(name), name.replace(".jsonl", ""));
			const body = serializeCurt(conversation, "curt-convert@0.1.0", conversation.extensions);
			const parsed = parseCurt(body);
			expect(parsed).not.toBeNull();
			expect(parsed?.messages).toHaveLength(conversation.messages.length);
			expect(parsed?.extensions).toEqual(conversation.extensions);
		});
	}

	it("serializeResult produces a parseable body", () => {
		const result = convertTranscript(fx("basic.jsonl"), "session-basic");
		expect(parseCurt(serializeResult(result))?.title).toBe("Widget refactor planning");
	});
});

describe("timestamp helper", () => {
	it("parses ISO strings and rejects junk", () => {
		expect(parseTimestamp("2026-10-03T12:00:00.000Z")).toBe(
			Date.parse("2026-10-03T12:00:00.000Z"),
		);
		expect(parseTimestamp("not-a-date")).toBe(0);
		expect(parseTimestamp(undefined)).toBe(0);
	});
});

describe("resolveOutputName (bulk collision safety)", () => {
	// Parent + sidechain JSONL files share one sessionId; their
	// curtFilename outputs collide.
	const jsonl = (uuid: string) =>
		JSON.stringify({
			type: "user",
			uuid,
			sessionId: "shared-session",
			timestamp: "2026-10-01T10:00:00.000Z",
			message: { role: "user", content: "hello there" },
		}) + "\n";
	const nameOf = (uuid: string) =>
		convertTranscript(jsonl(uuid), uuid).conversation.id;

	it("gives two same-sessionId inputs two distinct, deterministic names", () => {
		const seen = new Set<string>();
		const a = resolveOutputName("2026-10-01 hello-there shared-session.curt", "C:/a/parent.jsonl", seen);
		const b = resolveOutputName("2026-10-01 hello-there shared-session.curt", "C:/a/sidechain.jsonl", seen);
		expect(a).toBe("2026-10-01 hello-there shared-session.curt");
		expect(b).toMatch(/^2026-10-01 hello-there shared-session-[0-9a-f]{6}\.curt$/);
		expect(a).not.toBe(b);
		// deterministic across runs
		const seen2 = new Set<string>();
		expect(resolveOutputName("2026-10-01 hello-there shared-session.curt", "C:/a/parent.jsonl", seen2)).toBe(a);
		expect(resolveOutputName("2026-10-01 hello-there shared-session.curt", "C:/a/sidechain.jsonl", seen2)).toBe(b);
	});

	it("leaves non-colliding names unchanged", () => {
		const seen = new Set<string>();
		expect(resolveOutputName("x.curt", "C:/p/1.jsonl", seen)).toBe("x.curt");
		expect(resolveOutputName("y.curt", "C:/p/2.jsonl", seen)).toBe("y.curt");
		expect(seen.size).toBe(2);
	});

	it("discriminator for a colliding input depends only on its source path", () => {
		const seenA = new Set<string>();
		const seenB = new Set<string>();
		resolveOutputName("same.curt", "C:/s/two.jsonl", seenA);
		const a = resolveOutputName("same.curt", "C:/s/one.jsonl", seenA);
		resolveOutputName("same.curt", "C:/s/three.jsonl", seenB);
		const b = resolveOutputName("same.curt", "C:/s/one.jsonl", seenB);
		expect(a).toBe(b);
		expect(a).toMatch(/^same-[0-9a-f]{6}\.curt$/);
	});

	it("bulk-converting a shared-sessionId pair writes two files, deterministically", () => {
		// Fixed path (not mkdtemp): the discriminator hashes the source
		// path, so determinism across runs requires identical paths.
		const dir = join(tmpdir(), "curt-convert-collision-test");
		const run = () => {
			rmSync(dir, { recursive: true, force: true });
			mkdirSync(dir, { recursive: true });
			try {
				const parent = join(dir, "parent.jsonl");
				const sidechain = join(dir, "sidechain.jsonl");
				writeFileSync(parent, jsonl("u-1"));
				writeFileSync(sidechain, jsonl("u-2"));
				const seen = new Set<string>();
				for (const file of [parent, sidechain]) {
					const { conversation } = convertTranscript(readFileSync(file, "utf8"));
					const base = "2026-10-01 hello-there shared-session.curt";
					writeFileSync(join(dir, resolveOutputName(base, file, seen)), serializeResult({ conversation, stats: {
						messages: 1, toolCalls: 0, toolResults: 0, unlinkedToolResults: 0,
						skippedNoise: 0, skippedMeta: 0, parseErrors: 0,
					} }));
				}
				return readdirSync(dir).filter((f) => f.endsWith(".curt")).sort();
			} finally {
				rmSync(dir, { recursive: true, force: true });
			}
		};
		const first = run();
		expect(first).toHaveLength(2);
		// "-" sorts before ".", so the discriminated name comes first
		expect(first[0]).toMatch(/shared-session-[0-9a-f]{6}\.curt$/);
		expect(first[1]).toBe("2026-10-01 hello-there shared-session.curt");
		expect(run()).toEqual(first);
	});

	it("both written outputs still round-trip through parseCurt", () => {
		const seen = new Set<string>();
		const names = [
			resolveOutputName("2026-10-01 hello-there shared-session.curt", "C:/a/parent.jsonl", seen),
			resolveOutputName("2026-10-01 hello-there shared-session.curt", "C:/a/sidechain.jsonl", seen),
		];
		for (const name of names) {
			const { conversation } = convertTranscript(jsonl("u-1"));
			expect(parseCurt(serializeResult({ conversation, stats: {
				messages: 1, toolCalls: 0, toolResults: 0, unlinkedToolResults: 0,
				skippedNoise: 0, skippedMeta: 0, parseErrors: 0,
			} }))).not.toBeNull();
			expect(name.endsWith(".curt")).toBe(true);
		}
	});
});
