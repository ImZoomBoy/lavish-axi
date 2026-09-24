import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import { fileURLToPath } from "node:url";
import test from "node:test";

process.env.LAVISH_AXI_HOST = "127.0.0.1";
process.env.LAVISH_AXI_LINK_HOST = "127.0.0.1";

import { VERSION } from "../src/cli.js";

// The CLI reads open connections with netstat on Windows and lsof elsewhere.
const CANNOT_LIST_CONNECTIONS =
  process.platform !== "win32" && spawnSync("lsof", ["-v"], { encoding: "utf8" }).error
    ? "lsof is not installed"
    : false;

function spawnCli(args, env) {
  const child = spawn(process.execPath, [fileURLToPath(new URL("../bin/lavish-axi.js", import.meta.url)), ...args], {
    cwd: fileURLToPath(new URL("..", import.meta.url)),
    env,
  });
  const output = { stdout: "", stderr: "" };
  child.stdout.on("data", (chunk) => {
    output.stdout += chunk.toString();
  });
  child.stderr.on("data", (chunk) => {
    output.stderr += chunk.toString();
  });
  const closed = new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (code, signal) => resolve({ code, signal }));
  });
  return { child, output, closed };
}

function withTimeout(promise, ms, label) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`timed out: ${label}`)), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

// Stands in for a Lavish server from before the live report: /health answers with a version
// and no `live` field, and /shutdown closes it.
async function startOldVersionServer() {
  const requests = [];
  const sockets = new Set();
  const server = createServer((req, res) => {
    requests.push(`${req.method} ${req.url}`);
    if (req.url === "/health") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, app: "lavish-axi", version: "0.0.1-old-version-test" }));
      return;
    }
    if (req.url === "/shutdown") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ status: "shutting-down" }));
      server.close();
      for (const socket of sockets) socket.destroy();
      return;
    }
    if (req.url === "/api/end") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ status: "ended" }));
      return;
    }
    // /hold never answers. It stands in for a waiting poll or an open review page.
    if (req.url === "/hold") return;
    res.writeHead(404);
    res.end();
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("test server did not bind to a TCP port");
  return {
    port: address.port,
    requests,
    close: () =>
      new Promise((resolve) => {
        for (const socket of sockets) socket.destroy();
        server.close(() => resolve());
      }),
  };
}

test(
  "a CLI replaces an idle server that is too old to report live work",
  { skip: CANNOT_LIST_CONNECTIONS },
  async () => {
    const old = await startOldVersionServer();
    const stateDir = await mkdtemp(`${os.tmpdir()}/lavish-axi-old-idle-test-`);
    const artifact = `${stateDir}/artifact.html`;
    await writeFile(artifact, "<html><body>hello</body></html>", "utf8");
    const base = `http://127.0.0.1:${old.port}`;
    try {
      const open = spawnCli([artifact, "--no-open"], {
        ...process.env,
        LAVISH_AXI_STATE_DIR: stateDir,
        LAVISH_AXI_PORT: String(old.port),
        LAVISH_AXI_NO_OPEN: "1",
        LAVISH_AXI_TELEMETRY: "0",
      });
      const result = await withTimeout(open.closed, 30_000, "open against an idle old server");
      assert.ok(
        old.requests.includes("POST /shutdown"),
        `the idle old server was asked to stop: ${open.output.stderr}`,
      );
      assert.equal(result.code, 0, `${open.output.stdout}\n${open.output.stderr}`);
      assert.doesNotMatch(open.output.stderr, /as is/);
      const health = await (await fetch(`${base}/health`)).json();
      assert.equal(health.version, VERSION, "this CLI's server now holds the port");
    } finally {
      // The CLI started a detached server of its own on the port. Stop it.
      await fetch(`${base}/shutdown`, { method: "POST" }).catch(() => {});
      await old.close();
      await rm(stateDir, { force: true, recursive: true, maxRetries: 5, retryDelay: 200 });
    }
  },
);

test(
  "a CLI keeps a server too old to report live work while something is connected to it",
  { skip: CANNOT_LIST_CONNECTIONS },
  async () => {
    const old = await startOldVersionServer();
    const stateDir = await mkdtemp(`${os.tmpdir()}/lavish-axi-old-live-test-`);
    const artifact = `${stateDir}/artifact.html`;
    await writeFile(artifact, "<html><body>hello</body></html>", "utf8");
    const hold = new AbortController();
    try {
      fetch(`http://127.0.0.1:${old.port}/hold`, { signal: hold.signal }).catch(() => {});
      const deadline = Date.now() + 5000;
      while (!old.requests.includes("GET /hold") && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      const end = spawnCli(["end", artifact], {
        ...process.env,
        LAVISH_AXI_STATE_DIR: stateDir,
        LAVISH_AXI_PORT: String(old.port),
        LAVISH_AXI_TELEMETRY: "0",
      });
      const result = await withTimeout(end.closed, 30_000, "end against a connected old server");
      assert.equal(result.code, 0, `${end.output.stdout}\n${end.output.stderr}`);
      assert.equal(old.requests.includes("POST /shutdown"), false, "the connected old server was kept");
      assert.match(end.output.stderr, /too old to report live work/);
      assert.match(end.output.stderr, /open connections/);
    } finally {
      hold.abort();
      await old.close();
      await rm(stateDir, { force: true, recursive: true, maxRetries: 5, retryDelay: 200 });
    }
  },
);
