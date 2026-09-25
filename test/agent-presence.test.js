import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";

import { AGENT_QUIET_AFTER_MS, createAgentPresence } from "../src/agent-presence.js";

function setup(t) {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const events = new EventEmitter();
  /** @type {string[]} */
  const emitted = [];
  events.on("agent-presence", (key, state) => emitted.push(`${key}:${state}`));
  const presence = createAgentPresence(events, { quietAfterMs: 1000 });
  t.after(() => presence.close());
  return { presence, emitted, tick: (ms) => t.mock.timers.tick(ms) };
}

test("the quiet timeout is two minutes", () => {
  assert.equal(AGENT_QUIET_AFTER_MS, 120_000);
});

test("working goes quiet after the timeout with no poll attached", (t) => {
  const { presence, emitted, tick } = setup(t);
  presence.markWorking("a");
  tick(999);
  assert.equal(presence.state("a"), "working");
  tick(1);
  assert.equal(presence.state("a"), "quiet");
  assert.deepEqual(emitted, ["a:working", "a:quiet"]);
});

test("the clock starts when the delivering poll releases, not at delivery", (t) => {
  const { presence, tick } = setup(t);
  presence.pollAttached("a");
  presence.markWorking("a");
  tick(5000);
  assert.equal(presence.state("a"), "listening");
  presence.pollReleased("a");
  assert.equal(presence.state("a"), "working");
  tick(999);
  assert.equal(presence.state("a"), "working");
  tick(1);
  assert.equal(presence.state("a"), "quiet");
});

test("an ack restarts the clock and brings a quiet session back to working", (t) => {
  const { presence, emitted, tick } = setup(t);
  presence.markWorking("a");
  tick(900);
  presence.markWorking("a");
  tick(900);
  assert.equal(presence.state("a"), "working", "the ack restarted the clock");
  tick(100);
  assert.equal(presence.state("a"), "quiet");
  presence.markWorking("a");
  assert.equal(presence.state("a"), "working");
  assert.deepEqual(emitted, ["a:working", "a:quiet", "a:working"]);
});

test("a poll attaching ends working and quiet", (t) => {
  const { presence, tick } = setup(t);
  presence.markWorking("a");
  tick(1000);
  presence.pollAttached("a");
  assert.equal(presence.state("a"), "listening");
  tick(5000);
  presence.pollReleased("a");
  assert.equal(presence.state("a"), "waiting", "a poll that delivered nothing leaves nothing to work on");
  tick(5000);
  assert.equal(presence.state("a"), "waiting");
});

test("an agent reply or end clears working and its clock", (t) => {
  const { presence, emitted, tick } = setup(t);
  presence.markWorking("a");
  presence.clear("a");
  tick(5000);
  assert.equal(presence.state("a"), "waiting");
  assert.deepEqual(emitted, ["a:working", "a:waiting"]);
});

test("sessions keep separate clocks", (t) => {
  const { presence, tick } = setup(t);
  presence.markWorking("a");
  tick(500);
  presence.markWorking("b");
  tick(500);
  assert.equal(presence.state("a"), "quiet");
  assert.equal(presence.state("b"), "working");
});
