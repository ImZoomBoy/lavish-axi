import assert from "node:assert/strict";
import test from "node:test";

import {
  assessServerLiveWork,
  countServerConnections,
  keptServerNotice,
  parseLsofConnections,
  parseNetstatConnections,
} from "../src/cli.js";

test("assessServerLiveWork trusts a live report and counts connections when there is none", () => {
  const health = (live) => ({ ok: true, app: "lavish-axi", version: "0.1.67", ...(live ? { live } : {}) });
  const never = () => {
    throw new Error("a server that reports live work is never probed");
  };
  const assess = (body, countConnections) => assessServerLiveWork(body, { countConnections });
  assert.deepEqual(assess(health({ polls: 1, pages: 0 }), never), { live: true, basis: "report" });
  assert.deepEqual(assess(health({ polls: 0, pages: 2 }), never), { live: true, basis: "report" });
  assert.deepEqual(assess(health({ polls: 0, pages: 0 }), never), { live: false, basis: "report" });
  assert.deepEqual(
    assess(health(null), () => 0),
    { live: false, basis: "connections" },
  );
  assert.deepEqual(
    assess(health(null), () => 2),
    { live: true, basis: "connections" },
  );
  assert.deepEqual(
    assess(health(null), () => null),
    { live: true, basis: "unknown" },
  );
  assert.equal(assess({ ok: true }, never).live, false, "pre-handshake servers are still replaced");
  assert.equal(assess({ ok: true, app: "other", version: "1.0.0" }, never).live, false);
  assert.equal(assess(null, never).live, false);
});

test("the kept-server notice says what happens next for each basis", () => {
  const notice = (basis) => keptServerNotice({ port: 4511, serverVersion: "0.1.67", cliVersion: "0.1.48", basis });
  assert.match(notice("report"), /live polls or open review pages/);
  assert.match(notice("report"), /replaces it once nothing is connected/);
  assert.match(notice("connections"), /too old to report live work/);
  assert.match(notice("connections"), /open connections/);
  assert.match(notice("connections"), /replaces it once nothing is connected/);
  assert.match(notice("unknown"), /could not check/);
  assert.doesNotMatch(notice("unknown"), /replaces it once nothing is connected/);
  assert.match(notice("unknown"), /`lavish-axi stop`/);
});

const NETSTAT_SAMPLE = [
  "",
  "Active Connections",
  "",
  "  Proto  Local Address          Foreign Address        State           PID",
  "  TCP    127.0.0.1:4511         0.0.0.0:0              LISTENING       500",
  "  TCP    127.0.0.1:4511         127.0.0.1:60001        ESTABLISHED     500",
  "  TCP    127.0.0.1:60001        127.0.0.1:4511         ESTABLISHED     700",
  "  TCP    127.0.0.1:4511         127.0.0.1:60002        ESTABLISHED     500",
  "  TCP    127.0.0.1:60002        127.0.0.1:4511         ESTABLISHED     900",
  "  TCP    127.0.0.1:4511         127.0.0.1:60003        TIME_WAIT       0",
  "  TCP    127.0.0.1:4511         127.0.0.1:60005        CLOSE_WAIT      500",
  "  TCP    127.0.0.1:45110        0.0.0.0:0              LISTENING       501",
  "  TCP    127.0.0.1:45110        127.0.0.1:60006        ESTABLISHED     501",
  "  TCP    [::1]:4511             [::]:0                 LISTENING       500",
  "  UDP    0.0.0.0:5353           *:*                                    1200",
  "",
].join("\r\n");

test("netstat output counts the server's connections, leaving out the CLI's own", () => {
  const rows = parseNetstatConnections(NETSTAT_SAMPLE);
  assert.equal(countServerConnections(rows, 4511, 900), 1, "only the connection from pid 700 is foreign");
  assert.equal(countServerConnections(rows, 4511, 700), 1, "only the connection from pid 900 is foreign");
  assert.equal(countServerConnections(rows, 4511, 1), 2);
  assert.equal(countServerConnections(rows, 4512, 1), null, "no listener seen means no answer");
  const idle = parseNetstatConnections(
    NETSTAT_SAMPLE.split("\r\n")
      .filter((line) => !/:6000[12]\b/.test(line))
      .join("\r\n"),
  );
  assert.equal(countServerConnections(idle, 4511, 1), 0);
});

test("lsof output counts the server's connections, leaving out the CLI's own", () => {
  const sample = [
    "p500",
    "f20",
    "n127.0.0.1:4511",
    "TST=LISTEN",
    "f21",
    "n127.0.0.1:4511->127.0.0.1:60001",
    "TST=ESTABLISHED",
    "f22",
    "n[::1]:4511->[::1]:60002",
    "TST=ESTABLISHED",
    "f23",
    "n127.0.0.1:4511->127.0.0.1:60004",
    "TST=CLOSE_WAIT",
    "p700",
    "f30",
    "n127.0.0.1:60001->127.0.0.1:4511",
    "TST=ESTABLISHED",
    "p900",
    "f40",
    "n[::1]:60002->[::1]:4511",
    "TST=ESTABLISHED",
    "",
  ].join("\n");
  const rows = parseLsofConnections(sample);
  assert.equal(countServerConnections(rows, 4511, 900), 1);
  assert.equal(countServerConnections(rows, 4511, 1), 2);
  assert.equal(countServerConnections(parseLsofConnections(""), 4511, 1), null);
});
