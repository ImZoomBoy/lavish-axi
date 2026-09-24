import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { connectLivePage } from "./live-page-client.js";

process.env.LAVISH_AXI_HOST = "127.0.0.1";
process.env.LAVISH_AXI_LINK_HOST = "127.0.0.1";

const { serve } = await import("../src/server.js");
const { canonicalFile, sessionKey } = await import("../src/session-store.js");

// A state.json written by lavish-axi 0.1.48, before live updates moved to a WebSocket: six
// sessions across three projects with queued feedback, an unacknowledged delivery, agent and
// user ends, chat history, and a saved whiteboard. Artifact paths sit under a placeholder root.
const fixtureDir = new URL("./fixtures/pre-websocket/state/", import.meta.url);
const ROOT = "__ARTIFACT_ROOT__";

/**
 * Recreates the fixture's artifacts under a temp root. Session keys hash the artifact path, so
 * each key is re-derived from its new path; every other field is kept as written.
 */
async function materializeFixture(temp) {
  const root = path.join(temp, "projects");
  const stateDir = path.join(temp, "state");
  const fixture = JSON.parse(await readFile(new URL("state.json", fixtureDir), "utf8"));
  const keys = new Map();
  for (const session of Object.values(fixture.sessions)) {
    const file = path.join(root, ...session.file.slice(ROOT.length + 1).split("/"));
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(
      file,
      '<!doctype html><html><body><pre class="mermaid">flowchart LR\n  A --> B</pre></body></html>',
    );
    keys.set(session.key, sessionKey(await canonicalFile(file)));
  }
  let text = JSON.stringify(fixture, (_name, value) =>
    typeof value === "string" && value.startsWith(`${ROOT}/`)
      ? path.join(root, ...value.slice(ROOT.length + 1).split("/"))
      : value,
  );
  for (const [oldKey, newKey] of keys) text = text.split(oldKey).join(newKey);
  const state = JSON.parse(text);
  await mkdir(stateDir, { recursive: true });
  const stateFile = path.join(stateDir, "state.json");
  const written = `${JSON.stringify(state, null, 2)}\n`;
  await writeFile(stateFile, written);
  for (const [oldKey, newKey] of keys) {
    await cp(new URL(`whiteboards/${oldKey}/`, fixtureDir), path.join(stateDir, "whiteboards", newKey), {
      recursive: true,
    }).catch((error) => {
      if (error.code !== "ENOENT") throw error;
    });
  }
  const byName = Object.fromEntries(
    Object.values(state.sessions).map((session) => [path.basename(session.file, ".html"), session]),
  );
  return { stateFile, written, sessions: state.sessions, byName };
}

function chromeBootstrap(html) {
  const match = String(html).match(/<script id="lavish-session" type="application\/json">([\s\S]*?)<\/script>/);
  assert.ok(match);
  return JSON.parse(match[1]);
}

test("every session in a pre-WebSocket state file opens on the new server and keeps its feedback", async () => {
  const temp = await mkdtemp(path.join(tmpdir(), "lavish-pre-websocket-state-"));
  const { stateFile, written, sessions, byName } = await materializeFixture(temp);
  const server = await serve({ port: 0, stateFile, version: "9.9.9-test", idleTimeoutMs: null });
  const base = `http://127.0.0.1:${server.port}`;
  const post = (url, body) =>
    fetch(`${base}${url}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }).then((res) => res.json());
  const poll = (file) =>
    fetch(`${base}/api/poll?file=${encodeURIComponent(file)}&timeoutMs=0`).then((res) => res.json());

  try {
    assert.equal((await fetch(`${base}/health`)).status, 200);
    assert.equal(await readFile(stateFile, "utf8"), written, "starting the server rewrites no session record");

    // Every stored session serves its review page with its chat, over both live channels.
    for (const session of Object.values(sessions)) {
      const page = await fetch(`${base}/session/${session.key}`);
      assert.equal(page.status, 200, session.file);
      assert.deepEqual(
        chromeBootstrap(await page.text()).initialChat.map((item) => item.text),
        session.chat.map((item) => item.text),
      );
      const live = connectLivePage(base, session.key);
      assert.deepEqual(
        (await live.next("chat-sync")).chat.map((item) => item.text),
        session.chat.map((item) => item.text),
      );
      await live.close();
      const stream = await (await fetch(`${base}/events/${session.key}`)).text();
      assert.match(stream, /event: chat-sync/);
    }

    // Queued feedback survives a reopen and reaches the agent.
    const plan = byName.plan;
    assert.equal((await post("/api/sessions", { file: plan.file })).status, "opened");
    const planFeedback = await poll(plan.file);
    assert.equal(planFeedback.status, "feedback");
    assert.deepEqual(
      planFeedback.prompts.map((prompt) => prompt.prompt),
      plan.prompts.map((prompt) => prompt.prompt),
    );

    // A delivery the agent never acknowledged is delivered again, unchanged.
    const review = byName.review;
    const redelivered = await poll(review.file);
    assert.equal(redelivered.feedback_id, review.inflight_feedback.feedback_id);
    assert.deepEqual(redelivered.prompts, review.inflight_feedback.prompts);

    // Whiteboard edits load as saved, and the diagram's queued prompt is still there.
    const diagram = byName.diagram;
    const whiteboard = (await (await fetch(`${base}/api/${diagram.key}/whiteboard/0`)).json()).whiteboard;
    assert.equal(whiteboard.source_hash, "fixture-source-hash");
    assert.deepEqual(
      whiteboard.scene.elements.map((element) => element.id),
      ["A"],
    );
    assert.deepEqual(
      (await poll(diagram.file)).prompts.map((prompt) => prompt.prompt),
      ["Move Start left."],
    );

    // An agent-ended session reopens; a user-ended one still needs --reopen and still delivers
    // the prompts queued with its end.
    const notes = byName.notes;
    assert.equal((await post("/api/sessions", { file: notes.file })).status, "opened");
    const ended = byName.ended;
    assert.equal((await post("/api/sessions", { file: ended.file })).status, "user-ended");
    const finalBatch = await poll(ended.file);
    assert.deepEqual(
      finalBatch.prompts.map((prompt) => prompt.prompt),
      ["Ship it."],
    );
    assert.equal(finalBatch.session_ended, true);

    const board = byName.board;
    assert.equal((await poll(board.file)).status, "waiting");

    const after = JSON.parse(await readFile(stateFile, "utf8"));
    assert.deepEqual(Object.keys(after.sessions).sort(), Object.keys(sessions).sort(), "no session was dropped");
    assert.deepEqual(after.sessions[board.key].chat, board.chat);
  } finally {
    await server.close();
    await rm(temp, { recursive: true, force: true });
  }
});
