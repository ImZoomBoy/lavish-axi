import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

process.env.LAVISH_AXI_HOST = "127.0.0.1";
process.env.LAVISH_AXI_LINK_HOST = "127.0.0.1";

import {
  createAckOutput,
  createOpenOutput,
  createPollOutput,
  createUserEndedOpenOutput,
  pollInterruptedText,
  pollWaitBannerText,
  VERSION,
} from "../src/cli.js";
import { serve } from "../src/server.js";
import { canonicalFile } from "../src/session-store.js";

const CLI = fileURLToPath(new URL("../bin/lavish-axi.js", import.meta.url));
const REPO = fileURLToPath(new URL("..", import.meta.url));

// Agents run printed commands through a POSIX shell. On Windows that is Git Bash, which
// Claude Code, T3 Code, and the Claude desktop app all use. `bash` on PATH can be WSL's
// launcher there, so find Git Bash through git itself.
function findShells() {
  if (process.platform !== "win32") {
    return ["/bin/sh", "/bin/bash"].filter((shell) => existsSync(shell));
  }
  const execPath = spawnSync("git", ["--exec-path"], { encoding: "utf8" }).stdout?.trim();
  const candidates = [
    execPath ? path.resolve(execPath, "..", "..", "..", "bin", "bash.exe") : "",
    "C:\\Program Files\\Git\\bin\\bash.exe",
  ];
  const bash = candidates.find((candidate) => candidate && existsSync(candidate));
  return bash ? [bash] : [];
}

const SHELLS = findShells();

const END_OF_COMMAND = "--end-of-printed-command--";

// Runs printed commands in one shell where `lavish-axi` only prints the arguments it received,
// one per line, so the test sees exactly what the shell did to each printed path. One shell run
// per batch keeps the process count low.
function argvsAfterShell(shell, commands) {
  const script = [
    `lavish-axi() { for arg in "$@"; do printf '%s\\n' "$arg"; done; printf '%s\\n' ${END_OF_COMMAND}; }`,
    ...commands,
  ].join("\n");
  const result = spawnSync(shell, ["-c", script], { encoding: "utf8" });
  assert.equal(result.status, 0, `${shell} failed on:\n${script}\n${result.stderr}`);
  const lines = result.stdout.replace(/\r/g, "").split("\n");
  const argvs = [[]];
  for (const line of lines.slice(0, -1)) {
    if (line === END_OF_COMMAND) argvs.push([]);
    else argvs[argvs.length - 1].push(line);
  }
  argvs.pop();
  assert.equal(argvs.length, commands.length, `${shell} ran every command`);
  return argvs;
}

function printedCommands(text) {
  return [...text.matchAll(/`(lavish-axi [^`]*)`/g)].map((match) => match[1]);
}

function allPrintedCommands(file) {
  const feedback = { status: "feedback", feedback_id: "fb-1", prompts: [{ prompt: "p", tag: "message" }] };
  const texts = [
    createOpenOutput({ file, url: "http://127.0.0.1:1/session/k", status: "ready", selfPaintWarning: "w" }).next_step,
    createUserEndedOpenOutput({ file, url: "http://127.0.0.1:1/session/k" }).next_step,
    createPollOutput({ file, response: feedback }).next_step,
    createPollOutput({ file, response: { ...feedback, session_ended: true, ended_by: "agent" } }).next_step,
    createPollOutput({ file, response: { ...feedback, session_ended: true, ended_by: "user" } }).next_step,
    createPollOutput({
      file,
      response: { ...feedback, artifact_failures: [{ kind: "artifact-unavailable", detail: "x" }] },
    }).next_step,
    createPollOutput({ file, response: { status: "ended", ended_by: "user" } }).next_step,
    createPollOutput({ file, response: { status: "ended", ended_by: "agent" } }).next_step,
    createPollOutput({ file, response: { status: "waiting" } }).next_step,
    createAckOutput({ absolute: file, response: { status: "acknowledged" }, feedbackId: "fb-1" }).next_step,
    pollWaitBannerText(file),
    pollInterruptedText(file),
  ];
  const commands = [
    createOpenOutput({ file, url: "http://127.0.0.1:1/session/k", status: "ready" }).poll_command,
    ...texts.flatMap(printedCommands),
  ];
  let missing;
  try {
    createPollOutput({ file, response: { status: "missing" } });
  } catch (error) {
    missing = error;
  }
  commands.push(...missing.suggestions.flatMap(printedCommands));
  return commands.filter((command) => command.includes(path.basename(file).slice(0, 4)));
}

// UNC paths (\\server\share) are left out: Git Bash's own Windows command-line parsing turns a
// doubled backslash into one before bash sees the command, so no quoting can carry them.
const PATHS = [
  "C:\\Users\\Test User\\AppData\\Local\\Temp\\art\\review.html",
  "C:\\Users\\Glyn\\AppData\\Local\\Temp\\lavt3d\\art\\t3-alone.html",
  "C:\\Users\\it's $HOME\\plan.html",
  "/tmp/plain/review.html",
  "/tmp/with space/it's $HOME/review.html",
];

test("every printed command passes its file path through a shell unchanged", { skip: SHELLS.length === 0 }, () => {
  for (const file of PATHS) {
    const commands = allPrintedCommands(file);
    assert.ok(commands.length >= 12, `expected the printed commands for ${file}, got ${commands.length}`);
    for (const shell of SHELLS) {
      const argvs = argvsAfterShell(shell, commands);
      commands.forEach((command, index) => {
        const argv = argvs[index];
        assert.ok(argv.includes(file), `${shell} mangled the path in: ${command}\nargv: ${JSON.stringify(argv)}`);
      });
    }
  }
});

test("the printed poll command runs as printed from a shell", { skip: SHELLS.length === 0 }, async () => {
  const stateDir = await mkdtemp(`${os.tmpdir()}/lavish-axi-printed-command-test-`);
  const artifactDir = path.join(stateDir, "art dir");
  await mkdir(artifactDir);
  const artifact = path.join(artifactDir, "review.html");
  await writeFile(artifact, "<html><body>hello</body></html>", "utf8");
  const server = await serve({ port: 0, stateFile: `${stateDir}/state.json`, version: VERSION });
  const env = {
    ...process.env,
    LAVISH_AXI_STATE_DIR: stateDir,
    LAVISH_AXI_PORT: String(server.port),
    LAVISH_AXI_NO_OPEN: "1",
    LAVISH_AXI_TELEMETRY: "0",
    LAVISH_NODE: process.execPath,
    LAVISH_CLI: CLI,
  };
  try {
    await fetch(`http://127.0.0.1:${server.port}/api/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ file: await canonicalFile(artifact) }),
    });
    const { poll_command: pollCommand } = createOpenOutput({
      file: await canonicalFile(artifact),
      url: "",
      status: "ready",
    });
    for (const shell of SHELLS) {
      const script = `lavish-axi() { "$LAVISH_NODE" "$LAVISH_CLI" "$@"; }\n${pollCommand} --timeout-ms 200`;
      // Async spawn: the server runs on this process's event loop, which spawnSync would block.
      const child = spawn(shell, ["-c", script], { cwd: REPO, env });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk) => {
        stdout += chunk.toString();
      });
      child.stderr.on("data", (chunk) => {
        stderr += chunk.toString();
      });
      const code = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          child.kill();
          reject(new Error(`timed out running: ${pollCommand}`));
        }, 20_000);
        child.on("error", reject);
        child.on("close", (exitCode) => {
          clearTimeout(timer);
          resolve(exitCode);
        });
      });
      assert.equal(code, 0, `${shell} could not run: ${pollCommand}\n${stdout}\n${stderr}`);
      assert.match(stdout, /status: waiting/);
    }
  } finally {
    await server.close();
    await rm(stateDir, { force: true, recursive: true });
  }
});
