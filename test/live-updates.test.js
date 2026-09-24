import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { connectLivePage } from "./live-page-client.js";

process.env.LAVISH_AXI_HOST = "127.0.0.1";
process.env.LAVISH_AXI_LINK_HOST = "127.0.0.1";

const { serve } = await import("../src/server.js");
const { LEGACY_PAGE_TTL_MS } = await import("../src/live-updates.js");

async function withServer(run, options = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), "lavish-live-"));
  const stateFile = path.join(dir, "state.json");
  let server = await serve({ port: 0, stateFile, version: "9.9.9-test", idleTimeoutMs: null, ...options });
  const context = {
    dir,
    stateFile,
    get base() {
      return `http://127.0.0.1:${server.port}`;
    },
    get port() {
      return server.port;
    },
    async openSession(name = "artifact.html") {
      const file = path.join(dir, name);
      await writeFile(file, "<!doctype html><html><body><p>hi</p></body></html>");
      const res = await fetch(`${context.base}/api/sessions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ file }),
      });
      const body = await res.json();
      return { file, key: body.key };
    },
    async restart() {
      const port = server.port;
      await server.close();
      server = await serve({ port, stateFile, version: "9.9.9-test", idleTimeoutMs: null, ...options });
    },
    async health() {
      return (await fetch(`${context.base}/health`)).json();
    },
  };
  try {
    await run(context);
  } finally {
    await server.close();
    await rm(dir, { recursive: true, force: true });
  }
}

const connectLive = connectLivePage;

async function waitFor(check, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.fail("condition not met in time");
}

async function postAgentReply(base, key, text) {
  const res = await fetch(`${base}/api/${key}/agent-reply`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text }),
  });
  assert.equal(res.status, 200);
}

/** Reads one `/events/:key` response to its end and returns the parsed frames. */
async function pollLegacyStream(base, key, lastEventId) {
  const request = () =>
    fetch(`${base}/events/${key}`, {
      headers: lastEventId ? { "last-event-id": lastEventId } : {},
      signal: AbortSignal.timeout(3000),
    });
  // After a restart, Node's fetch can reuse a pooled socket the old server closed. An EventSource
  // simply reconnects, so retry once the same way.
  const res = await request().catch(request);
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type") || "", /text\/event-stream/);
  const text = await res.text();
  const frames = text
    .split("\n\n")
    .filter(Boolean)
    .map((block) => {
      /** @type {Record<string, any>} */
      const frame = {};
      for (const line of block.split("\n")) {
        const [field, ...rest] = line.split(": ");
        frame[field] = rest.join(": ");
      }
      return frame;
    });
  const retry = frames.find((frame) => "retry" in frame);
  /** @type {Array<Record<string, any>>} */
  const events = frames.filter((frame) => frame.event).map((frame) => ({ ...frame, data: JSON.parse(frame.data) }));
  const cursor = [...events].reverse().find((frame) => frame.id)?.id;
  return { retry: retry ? Number(retry.retry) : null, events, cursor };
}

test("a review page receives every live event over a WebSocket", async () => {
  await withServer(async ({ base, openSession, health }) => {
    const { key } = await openSession();
    const live = connectLive(base, key);
    await live.opened;

    assert.deepEqual(await live.next("chat-sync"), { chat: [] });
    assert.deepEqual(await live.next("agent-presence"), { state: "waiting" });
    assert.deepEqual((await health()).live, { polls: 0, pages: 1 });

    await postAgentReply(base, key, "Updated the title.");
    assert.deepEqual(await live.next("agent-reply"), { text: "Updated the title." });

    await live.close();
    await waitFor(async () => (await health()).live.pages === 0);
  });
});

test("the WebSocket handshake refuses other origins and disallowed hosts", async () => {
  await withServer(async ({ base, openSession }) => {
    const { key } = await openSession();

    const crossOrigin = connectLive(base, key, { origin: "https://evil.example" });
    await assert.rejects(crossOrigin.opened, /handshake refused: 403/);

    const sandboxedArtifact = connectLive(base, key, { origin: "null" });
    await assert.rejects(sandboxedArtifact.opened, /handshake refused: 403/);

    const rebound = connectLive(base, key, { host: "evil.example" });
    await assert.rejects(rebound.opened, /handshake refused: 403/);

    const sameOrigin = connectLive(base, key, { origin: base });
    await sameOrigin.opened;
    await sameOrigin.close();
  });
});

test("many open pages add no emitter listeners, and closed pages are released", async () => {
  const warnings = [];
  const onWarning = (warning) => warnings.push(`${warning.name}: ${warning.message}`);
  process.on("warning", onWarning);
  try {
    await withServer(async ({ base, openSession, health }) => {
      const { key } = await openSession();
      const pages = Array.from({ length: 15 }, () => connectLive(base, key));
      await Promise.all(pages.map((page) => page.opened));
      assert.equal((await health()).live.pages, 15);

      await postAgentReply(base, key, "to everyone");
      for (const page of pages) assert.deepEqual(await page.next("agent-reply"), { text: "to everyone" });

      await Promise.all(pages.map((page) => page.close()));
      // Pages that disconnect while the server is still sending their first snapshot.
      for (let i = 0; i < 20; i += 1) {
        const page = connectLive(base, key);
        page.socket.once("open", () => page.socket.terminate());
        await page.closed;
      }
      await waitFor(async () => (await health()).live.pages === 0);
    });
  } finally {
    process.off("warning", onWarning);
  }
  assert.deepEqual(warnings, []);
});

test("an EventSource page from before the WebSocket change is served as a short poll", async () => {
  await withServer(async ({ base, openSession, health }) => {
    const { key } = await openSession();

    const first = await pollLegacyStream(base, key);
    assert.ok(first.retry && first.retry <= 2000, "tells the EventSource to reconnect soon");
    assert.deepEqual(
      first.events.map((frame) => frame.event),
      ["chat-sync", "agent-presence", "lavish-cursor"],
    );
    assert.ok(first.cursor);
    assert.equal((await health()).live.pages, 1, "a polling page counts as an open page");

    await postAgentReply(base, key, "first");
    await postAgentReply(base, key, "second");
    const second = await pollLegacyStream(base, key, first.cursor);
    assert.deepEqual(
      second.events.filter((frame) => frame.event === "agent-reply").map((frame) => frame.data.text),
      ["first", "second"],
    );
    assert.equal(
      second.events.some((frame) => frame.event === "chat-sync"),
      false,
      "a known cursor gets only what it missed",
    );

    const third = await pollLegacyStream(base, key, second.cursor);
    assert.deepEqual(
      third.events.map((frame) => frame.event),
      ["lavish-cursor"],
    );
    assert.equal((await health()).live.pages, 1, "the same page is not counted twice");
  });
});

test("a polling page stops counting as open once it stops reconnecting", async () => {
  let clock = 1_000_000;
  const realNow = Date.now;
  Date.now = () => clock;
  try {
    await withServer(async ({ base, openSession, health }) => {
      const { key } = await openSession();
      await pollLegacyStream(base, key);
      assert.equal((await health()).live.pages, 1);
      clock += LEGACY_PAGE_TTL_MS + 1;
      assert.equal((await health()).live.pages, 0);
    });
  } finally {
    Date.now = realNow;
  }
});

test("six held pages no longer block a seventh request to the same server", async () => {
  await withServer(async ({ base, openSession }) => {
    const { key } = await openSession();
    // Old pages poll; none of them keeps its response open.
    for (let i = 0; i < 8; i += 1) {
      const started = Date.now();
      await pollLegacyStream(base, key);
      assert.ok(Date.now() - started < 1500, "the legacy response ends on its own");
    }
  });
});

test("a WebSocket page reconnects after a server restart and keeps receiving events", async () => {
  await withServer(async ({ openSession, restart, ...context }) => {
    const { key } = await openSession();
    const before = connectLive(context.base, key);
    await before.opened;
    await before.next("agent-presence");

    const restarting = restart();
    assert.deepEqual(await before.next("chrome-reload"), {});
    assert.equal(await before.closed, 1012);
    await restarting;

    const after = connectLive(context.base, key);
    await after.opened;
    assert.deepEqual(await after.next("agent-presence"), { state: "waiting" });
    await postAgentReply(context.base, key, "after restart");
    assert.deepEqual(await after.next("agent-reply"), { text: "after restart" });
    await after.close();
  });
});

test("a polling page resyncs after a server restart", async () => {
  await withServer(async ({ openSession, restart, ...context }) => {
    const { key } = await openSession();
    const first = await pollLegacyStream(context.base, key);
    await postAgentReply(context.base, key, "before restart");
    await restart();
    const after = await pollLegacyStream(context.base, key, first.cursor);
    const sync = after.events.find((frame) => frame.event === "chat-sync");
    assert.ok(sync, "an unknown cursor gets a full snapshot");
    assert.deepEqual(
      sync.data.chat.map((item) => item.text),
      ["before restart"],
    );
  });
});
