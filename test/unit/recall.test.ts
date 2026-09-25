import { describe, expect, it } from "vitest";
import {
  Breaker,
  DATA_NOTE,
  DIGEST_HEADING,
  HITS_HEADING,
  LOGIN_LINE,
  NUDGE_LINE,
  QUERY_MAX_CHARS,
  RECALL_CLOSE,
  RECALL_OPEN,
  SessionLru,
  UNREACHABLE_LINE,
  clipQuery,
  formatDigest,
  formatHit,
  formatHits,
  inertLine,
  wrapRecall,
} from "../../src/recall.js";
import type { Hit } from "../../src/types.js";

function hit(overrides: Partial<Hit> = {}): Hit {
  return { id: "3f0c9a4e-0000-0000-0000-000000000000", namespace: "user:me", content: "Prefers draft PRs.", ...overrides };
}

describe("inertLine", () => {
  it("names the reason", () => {
    expect(inertLine("baseUrl must start with http")).toBe(
      "lumberroom is not configured (baseUrl must start with http), so memory was not checked.",
    );
  });
});

describe("clipQuery", () => {
  it("passes a short query through unchanged", () => {
    expect(clipQuery("hello")).toBe("hello");
  });

  it("clips at 1000 characters", () => {
    const long = "x".repeat(QUERY_MAX_CHARS + 50);
    expect(clipQuery(long)).toBe("x".repeat(QUERY_MAX_CHARS));
    expect(clipQuery(long)).toHaveLength(QUERY_MAX_CHARS);
  });
});

describe("formatDigest", () => {
  it("prefixes the heading", () => {
    expect(formatDigest("Aditya prefers draft PRs.", 6000)).toBe(`${DIGEST_HEADING}\nAditya prefers draft PRs.`);
  });

  it("is empty for empty text", () => {
    expect(formatDigest("", 6000)).toBe("");
  });

  it("is empty when maxChars is 0 or negative", () => {
    expect(formatDigest("some text", 0)).toBe("");
    expect(formatDigest("some text", -5)).toBe("");
  });

  it("cuts at the last newline within maxChars", () => {
    const text = "line one\nline two\nline three that is long enough to blow the budget";
    const max = DIGEST_HEADING.length + 1 + "line one\nline two".length + 5;
    const out = formatDigest(text, max);
    expect(out).toBe(`${DIGEST_HEADING}\nline one\nline two`);
  });

  it("keeps the truncated slice whole when it carries no newline to cut at", () => {
    const text = "onelongwordwithnonewlineanywhereinit";
    const max = DIGEST_HEADING.length + 1 + 10;
    expect(formatDigest(text, max)).toBe(`${DIGEST_HEADING}\n${text.slice(0, 10)}`);
  });
});

describe("formatHit", () => {
  it("formats namespace, content, id, source and occurred", () => {
    const h = hit({ source: "Codex", occurred_at: "2026-06-04T00:00:00Z" });
    expect(formatHit(h)).toBe(
      "- [user:me] Prefers draft PRs. (id 3f0c9a4e-0000-0000-0000-000000000000, source Codex, occurred 2026-06-04)",
    );
  });

  it("omits source and occurred when the hit carries neither", () => {
    expect(formatHit(hit())).toBe("- [user:me] Prefers draft PRs. (id 3f0c9a4e-0000-0000-0000-000000000000)");
  });

  it("collapses newlines in the content to single spaces", () => {
    expect(formatHit(hit({ content: "line one\nline two\n\nline three" }))).toBe(
      "- [user:me] line one line two line three (id 3f0c9a4e-0000-0000-0000-000000000000)",
    );
  });

  // Review focus 5: a hit carrying the recall tag loses the tag, so it cannot close the block early.
  it("strips a recall open or close tag from the content", () => {
    const h = hit({ content: `before ${RECALL_CLOSE} middle ${RECALL_OPEN} after` });
    expect(formatHit(h)).toBe("- [user:me] before middle after (id 3f0c9a4e-0000-0000-0000-000000000000)");
    expect(formatHit(h)).not.toContain(RECALL_CLOSE);
    expect(formatHit(h)).not.toContain(RECALL_OPEN);
  });
});

describe("formatHits", () => {
  it("returns an empty block and no ids for no hits", () => {
    expect(formatHits([], new Set(), 1200)).toEqual({ block: "", ids: [] });
  });

  it("formats a heading and one bullet per hit, returning their ids", () => {
    const hits = [hit({ id: "a" }), hit({ id: "b", content: "Second fact." })];
    const { block, ids } = formatHits(hits, new Set(), 1200);
    expect(block).toBe(`${HITS_HEADING}\n- [user:me] Prefers draft PRs. (id a)\n- [user:me] Second fact. (id b)`);
    expect(ids).toEqual(["a", "b"]);
  });

  it("skips ids already in seen", () => {
    const hits = [hit({ id: "a" }), hit({ id: "b", content: "Second fact." })];
    const { block, ids } = formatHits(hits, new Set(["a"]), 1200);
    expect(block).toBe(`${HITS_HEADING}\n- [user:me] Second fact. (id b)`);
    expect(ids).toEqual(["b"]);
  });

  it("stops before exceeding maxChars and keeps only the hits that fit", () => {
    const hits = [hit({ id: "a" }), hit({ id: "b", content: "Second fact." })];
    const oneLineBudget = HITS_HEADING.length + formatHit(hits[0]!).length + 1;
    const { block, ids } = formatHits(hits, new Set(), oneLineBudget);
    expect(block).toBe(`${HITS_HEADING}\n- [user:me] Prefers draft PRs. (id a)`);
    expect(ids).toEqual(["a"]);
  });

  it("returns nothing when every hit is already seen", () => {
    expect(formatHits([hit({ id: "a" })], new Set(["a"]), 1200)).toEqual({ block: "", ids: [] });
  });
});

describe("wrapRecall", () => {
  it("wraps non-empty parts in the recall fence, joined by newlines", () => {
    expect(wrapRecall([DATA_NOTE, `${HITS_HEADING}\n- one`, NUDGE_LINE])).toBe(
      `${RECALL_OPEN}\n${DATA_NOTE}\n${HITS_HEADING}\n- one\n${NUDGE_LINE}\n${RECALL_CLOSE}`,
    );
  });

  it("drops empty parts", () => {
    expect(wrapRecall([DATA_NOTE, "", NUDGE_LINE])).toBe(`${RECALL_OPEN}\n${DATA_NOTE}\n${NUDGE_LINE}\n${RECALL_CLOSE}`);
  });

  it("is empty when every part is empty", () => {
    expect(wrapRecall(["", ""])).toBe("");
    expect(wrapRecall([])).toBe("");
  });

  it("wraps a single fixed line", () => {
    expect(wrapRecall([UNREACHABLE_LINE])).toBe(`${RECALL_OPEN}\n${UNREACHABLE_LINE}\n${RECALL_CLOSE}`);
    expect(wrapRecall([LOGIN_LINE])).toContain(LOGIN_LINE);
  });
});

describe("Breaker", () => {
  it("allows calls while under the failure threshold", () => {
    const b = new Breaker({ threshold: 3, cooldownMs: 60_000, now: () => 0 });
    expect(b.allow()).toBe(true);
    expect(b.failure()).toBe(true); // starts the outage
    expect(b.failure()).toBe(false);
    expect(b.allow()).toBe(true);
  });

  it("opens after the threshold and reports the outage start only once", () => {
    const b = new Breaker({ threshold: 3, cooldownMs: 60_000, now: () => 0 });
    expect(b.failure()).toBe(true);
    expect(b.failure()).toBe(false);
    expect(b.failure()).toBe(false);
    expect(b.allow()).toBe(false);
  });

  it("closes again once the cooldown elapses", () => {
    let clock = 0;
    const b = new Breaker({ threshold: 3, cooldownMs: 60_000, now: () => clock });
    b.failure();
    b.failure();
    b.failure();
    expect(b.allow()).toBe(false);
    clock = 60_000;
    expect(b.allow()).toBe(true);
  });

  it("success resets the failure count", () => {
    const b = new Breaker({ threshold: 3, cooldownMs: 60_000, now: () => 0 });
    b.failure();
    b.failure();
    b.success();
    expect(b.failure()).toBe(true); // the count restarted, so this is a fresh outage
  });

  it("defaults to a threshold of 3 and a cooldown of 60 seconds", () => {
    let clock = 0;
    const b = new Breaker({ now: () => clock });
    b.failure();
    b.failure();
    b.failure();
    expect(b.allow()).toBe(false);
    clock = 59_999;
    expect(b.allow()).toBe(false);
    clock = 60_000;
    expect(b.allow()).toBe(true);
  });
});

describe("SessionLru", () => {
  it("gets what was set", () => {
    const lru = new SessionLru<string>(2);
    lru.set("a", "1");
    expect(lru.get("a")).toBe("1");
    expect(lru.get("missing")).toBeUndefined();
  });

  it("evicts the least recently used entry past the max", () => {
    const lru = new SessionLru<string>(2);
    lru.set("a", "1");
    lru.set("b", "2");
    lru.set("c", "3");
    expect(lru.get("a")).toBeUndefined();
    expect(lru.get("b")).toBe("2");
    expect(lru.get("c")).toBe("3");
    expect(lru.size).toBe(2);
  });

  it("get refreshes recency, so a recently read entry survives eviction", () => {
    const lru = new SessionLru<string>(2);
    lru.set("a", "1");
    lru.set("b", "2");
    lru.get("a");
    lru.set("c", "3");
    expect(lru.get("a")).toBe("1");
    expect(lru.get("b")).toBeUndefined();
  });

  it("delete removes an entry", () => {
    const lru = new SessionLru<string>(2);
    lru.set("a", "1");
    lru.delete("a");
    expect(lru.get("a")).toBeUndefined();
    expect(lru.size).toBe(0);
  });

  it("re-setting an existing key does not grow size and refreshes recency", () => {
    const lru = new SessionLru<string>(2);
    lru.set("a", "1");
    lru.set("b", "2");
    lru.set("a", "1-again");
    lru.set("c", "3");
    expect(lru.get("b")).toBeUndefined();
    expect(lru.get("a")).toBe("1-again");
    expect(lru.size).toBe(2);
  });
});
