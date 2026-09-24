import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { isVersionOnlyArgv, VERSION } from "../src/cli.js";

const execFileAsync = promisify(execFile);
const BIN = fileURLToPath(new URL("../bin/lavish-axi.js", import.meta.url));

// A regression to the pre-fast-path behavior costs the full telemetry drain (up to
// 1000ms) plus process startup. This budget sits far below that and far above the
// ~60ms the fast path actually needs, so it catches the regression without flaking.
const VERSION_BUDGET_MS = 500;
// The full suite starts many test processes at once, and a cold start can queue behind them for
// CPU. The fastest of a few runs measures the command itself; a regression pays the drain on
// every run.
const VERSION_ATTEMPTS = 3;

// Accepts the telemetry connection and never answers, so a regression pays the whole
// drain timeout instead of a fast connection refusal.
async function startBlackHoleTelemetry() {
  const sockets = new Set();
  const requests = [];
  const server = createServer((req) => {
    requests.push(req.url);
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  await new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve(undefined));
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  return {
    requests,
    host: `http://127.0.0.1:${port}`,
    async close() {
      for (const socket of sockets) socket.destroy();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

test("isVersionOnlyArgv matches exactly the SDK's version-flag shapes", () => {
  for (const flag of ["--version", "-v", "-V"]) {
    assert.equal(isVersionOnlyArgv([flag]), true);
  }
  for (const argv of [[], ["--help"], ["open"], ["--version", "extra"], ["open", "--version"]]) {
    assert.equal(isVersionOnlyArgv(argv), false);
  }
});

test("--version prints the version fast and skips telemetry and state-dir init", async (t) => {
  const telemetry = await startBlackHoleTelemetry();
  const stateParent = await mkdtemp(path.join(tmpdir(), "lavish-version-"));
  const stateDir = path.join(stateParent, "state");
  t.after(async () => {
    await telemetry.close();
    await rm(stateParent, { recursive: true, force: true });
  });

  const env = {
    ...process.env,
    LAVISH_AXI_STATE_DIR: stateDir,
    LAVISH_AXI_TELEMETRY: "1",
    LAVISH_AXI_UMAMI_WEBSITE_ID: "version-fast-path-test",
    LAVISH_AXI_UMAMI_HOST: telemetry.host,
  };

  for (const flag of ["--version", "-v", "-V"]) {
    const timings = [];
    for (let attempt = 0; attempt < VERSION_ATTEMPTS; attempt += 1) {
      const startedAt = process.hrtime.bigint();
      const { stdout } = await execFileAsync(process.execPath, [BIN, flag], { env });
      timings.push(Math.round(Number(process.hrtime.bigint() - startedAt) / 1e6));
      assert.equal(stdout, `${VERSION}\n`);
      if (timings[timings.length - 1] < VERSION_BUDGET_MS) break;
    }
    assert.ok(
      Math.min(...timings) < VERSION_BUDGET_MS,
      `\`${flag}\` took ${timings.join("ms, ")}ms, over the ${VERSION_BUDGET_MS}ms budget`,
    );
  }

  // The heavy init is provably skipped: no telemetry request was ever sent, and the
  // state directory was never created.
  assert.deepEqual(telemetry.requests, []);
  assert.equal(existsSync(stateDir), false);
});

test("a non-version invocation still runs the telemetry init the fast path skips", async (t) => {
  const telemetry = await startBlackHoleTelemetry();
  const stateParent = await mkdtemp(path.join(tmpdir(), "lavish-version-control-"));
  const stateDir = path.join(stateParent, "state");
  t.after(async () => {
    await telemetry.close();
    await rm(stateParent, { recursive: true, force: true });
  });

  await execFileAsync(process.execPath, [BIN, "design"], {
    env: {
      ...process.env,
      LAVISH_AXI_STATE_DIR: stateDir,
      LAVISH_AXI_TELEMETRY: "1",
      LAVISH_AXI_UMAMI_WEBSITE_ID: "version-fast-path-test",
      LAVISH_AXI_UMAMI_HOST: telemetry.host,
    },
  });

  assert.ok(telemetry.requests.length > 0, "expected the control command to send telemetry");
  assert.equal(existsSync(stateDir), true);
});
