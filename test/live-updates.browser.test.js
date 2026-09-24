import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

process.env.LAVISH_AXI_HOST = "127.0.0.1";
process.env.LAVISH_AXI_LINK_HOST = "127.0.0.1";

const { serve } = await import("../src/server.js");
const { LEGACY_PAGE_TTL_MS } = await import("../src/live-updates.js");

// Chrome allows six HTTP/1.1 connections per host. When every review page held an EventSource,
// a seventh tab on the same server stayed blank. This drives one headless Chrome with more pages
// than that, some of them running the page code from before the WebSocket change (as tabs left
// open across an upgrade do), and checks that every page loads, sends feedback, and receives
// live events, including after a server restart.
const runBrowserE2e = process.env.LAVISH_AXI_BROWSER_E2E === "1";
const PAGE_COUNT = 9;
const LEGACY_PAGES = new Set([1, 5]);
const legacyChromeClient = new URL("./fixtures/pre-websocket/chrome-client.js.txt", import.meta.url);

function chromeExecutable() {
  const candidates = [
    process.env.LAVISH_AXI_CHROME_PATH,
    process.env.CHROME_PATH,
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
  ];
  const found = candidates.find((candidate) => candidate && existsSync(candidate));
  if (!found) throw new Error("no Chrome found; set LAVISH_AXI_CHROME_PATH");
  return found;
}

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen({ port: 0, host: "127.0.0.1" }, () => resolve(undefined));
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("failed to allocate a TCP port");
  await new Promise((resolve) => server.close(() => resolve(undefined)));
  return address.port;
}

async function waitFor(check, timeoutMs, message) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    last = await check();
    if (last === true) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.fail(`${message}: ${JSON.stringify(last)}`);
}

/** A minimal Chrome DevTools Protocol client over Node's built-in WebSocket. */
async function launchChrome(profileDir) {
  const child = spawn(
    chromeExecutable(),
    [
      "--headless=new",
      `--user-data-dir=${profileDir}`,
      "--remote-debugging-port=0",
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-background-timer-throttling",
      "--disable-renderer-backgrounding",
      "about:blank",
    ],
    { stdio: "ignore" },
  );
  const portFile = path.join(profileDir, "DevToolsActivePort");
  await waitFor(async () => existsSync(portFile) || "waiting", 20_000, "Chrome did not start");
  const [port, browserPath] = (await readFile(portFile, "utf8")).trim().split("\n");
  const socket = new WebSocket(`ws://127.0.0.1:${port}${browserPath}`);
  await new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve, { once: true });
    socket.addEventListener("error", reject, { once: true });
  });
  let nextId = 1;
  const pending = new Map();
  const listeners = [];
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(String(event.data));
    if (message.id && pending.has(message.id)) {
      const { resolve, reject } = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) reject(new Error(message.error.message));
      else resolve(message.result);
      return;
    }
    for (const listener of listeners) listener(message);
  });
  // A page queued behind the connection cap may not answer, so every call has a deadline.
  const send = (method, params = {}, sessionId = undefined) =>
    new Promise((resolve, reject) => {
      const id = nextId++;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`${method} timed out`));
      }, 5000);
      pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
      socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  return {
    send,
    onEvent(listener) {
      listeners.push(listener);
    },
    async close() {
      await send("Browser.close").catch(() => {});
      socket.close();
      await new Promise((resolve) => {
        if (child.exitCode !== null) resolve(undefined);
        else child.once("exit", resolve);
        setTimeout(() => {
          child.kill();
          resolve(undefined);
        }, 5000).unref();
      });
    },
  };
}

test(
  "more review pages than Chrome's per-host limit all load, send feedback, and get live events",
  { skip: !runBrowserE2e, timeout: 240_000 },
  async () => {
    const temp = await mkdtemp(path.join(tmpdir(), "lavish-live-browser-"));
    const stateFile = path.join(temp, "state", "state.json");
    await (await import("node:fs/promises")).mkdir(path.dirname(stateFile), { recursive: true });
    const port = Number(process.env.LAVISH_AXI_E2E_PORT) || (await freePort());
    let server = await serve({ port, stateFile, version: "live-e2e", idleTimeoutMs: null });
    const base = `http://127.0.0.1:${port}`;
    const chrome = await launchChrome(path.join(temp, "chrome"));
    const legacyClientSource = await readFile(legacyChromeClient, "utf8");

    try {
      /** @type {any[]} */
      const pages = [];
      for (let index = 0; index < PAGE_COUNT; index += 1) {
        const file = path.join(temp, `artifact-${index}.html`);
        await writeFile(file, `<!doctype html><html><body><h1>Artifact ${index}</h1></body></html>`);
        const opened = await (
          await fetch(`${base}/api/sessions`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ file, url: "" }),
          })
        ).json();
        pages.push({ index, file, key: opened.key, legacy: LEGACY_PAGES.has(index) });
      }

      // Tabs left open across an upgrade keep the page code they loaded. Serve those tabs the
      // pre-change chrome client, which holds an EventSource on /events/:key.
      chrome.onEvent((message) => {
        if (message.method !== "Fetch.requestPaused") return;
        // An old page cut off from the server, as when its laptop sleeps.
        if (message.params.request.url.includes("/events/")) {
          chrome
            .send(
              "Fetch.failRequest",
              { requestId: message.params.requestId, errorReason: "ConnectionRefused" },
              message.sessionId,
            )
            .catch(() => {});
          return;
        }
        chrome
          .send(
            "Fetch.fulfillRequest",
            {
              requestId: message.params.requestId,
              responseCode: 200,
              responseHeaders: [{ name: "content-type", value: "application/javascript" }],
              body: Buffer.from(legacyClientSource).toString("base64"),
            },
            message.sessionId,
          )
          .catch(() => {});
      });

      for (const page of pages) {
        const { targetId } = await chrome.send("Target.createTarget", { url: "about:blank" });
        const { sessionId } = await chrome.send("Target.attachToTarget", { targetId, flatten: true });
        page.sessionId = sessionId;
        await chrome.send("Runtime.enable", {}, sessionId);
        if (page.legacy) {
          await chrome.send("Fetch.enable", { patterns: [{ urlPattern: "*/chrome-client.js" }] }, sessionId);
        }
        // Do not wait for the load: a page queued behind the connection cap never finishes.
        chrome.send("Page.navigate", { url: `${base}/session/${page.key}` }, sessionId).catch(() => {});
      }

      const evaluate = async (page, expression) => {
        const result = await chrome.send(
          "Runtime.evaluate",
          { expression, returnByValue: true, awaitPromise: true },
          page.sessionId,
        );
        return result.result?.value;
      };
      const pageState = (page) =>
        evaluate(
          page,
          `(() => ({
            href: location.href,
            ready: document.readyState,
            chat: document.getElementById("chatLog")?.textContent || "",
            status: document.getElementById("feedbackStatus")?.textContent || "",
            statusHidden: document.getElementById("feedbackStatus")?.hidden ?? true,
            frameSrc: document.getElementById("artifact")?.getAttribute("src") || "",
          }))()`,
        ).catch((error) => ({ error: error.message }));

      await waitFor(
        async () => {
          const states = await Promise.all(pages.map(pageState));
          const notLoaded = states
            .map((state, index) => ({ index, href: state?.href, ready: state?.ready }))
            .filter((state) => state.ready !== "complete" || !String(state.href).includes("/session/"));
          return notLoaded.length === 0 || { notLoaded };
        },
        30_000,
        "every review page loads",
      );
      for (const page of pages) {
        const usesSocket = await evaluate(page, `typeof liveSocketUrl === "function"`);
        assert.equal(usesSocket, !page.legacy, `page ${page.index} runs the expected page code`);
      }

      async function expectAgentReplyEverywhere(text) {
        for (const page of pages) {
          const res = await fetch(`${base}/api/${page.key}/agent-reply`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ text: `${text} ${page.index}` }),
          });
          assert.equal(res.status, 200);
        }
        await waitFor(
          async () => {
            const states = await Promise.all(pages.map(pageState));
            const missing = pages.filter((page, i) => !states[i]?.chat.includes(`${text} ${page.index}`));
            return missing.length === 0 || { missing: missing.map((page) => page.index) };
          },
          20_000,
          `every page receives "${text}"`,
        );
      }

      await expectAgentReplyEverywhere("live reply");

      // Every page can send feedback, and the agent receives it.
      for (const page of pages) {
        await evaluate(
          page,
          `(() => {
            document.getElementById("chatInput").value = "feedback from page ${page.index}";
            document.getElementById("chatInput").dispatchEvent(new Event("input"));
            document.getElementById("send").click();
          })()`,
        );
      }
      for (const page of pages) {
        /** @type {any} */
        let delivery;
        await waitFor(
          async () => {
            delivery = await (await fetch(`${base}/api/poll?file=${encodeURIComponent(page.file)}&timeoutMs=0`)).json();
            return delivery.status === "feedback" || delivery;
          },
          20_000,
          `feedback from page ${page.index} reaches the agent`,
        );
        assert.ok(
          delivery.prompts.some((prompt) => prompt.prompt === `feedback from page ${page.index}`),
          JSON.stringify(delivery),
        );
        page.feedbackId = delivery.feedback_id;
      }
      // The delivery receipt is a live event too.
      await waitFor(
        async () => {
          const states = await Promise.all(pages.map(pageState));
          const missing = pages.filter((_, i) => !/delivered|received|read/i.test(states[i]?.status || ""));
          return missing.length === 0 || { missing: states.map((state) => state?.status) };
        },
        20_000,
        "every page shows the delivery receipt",
      );
      for (const page of pages) {
        await fetch(`${base}/api/${page.key}/feedback-ack`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ feedback_id: page.feedbackId }),
        });
      }

      // An edit to the artifact reloads it in its page.
      const framesBefore = await Promise.all(pages.map(pageState));
      for (const page of pages) {
        await writeFile(page.file, `<!doctype html><html><body><h1>Edited ${page.index}</h1></body></html>`);
      }
      await waitFor(
        async () => {
          const states = await Promise.all(pages.map(pageState));
          const stale = pages.filter((_, i) => states[i]?.frameSrc === framesBefore[i]?.frameSrc);
          return stale.length === 0 || { stale: stale.map((page) => page.index) };
        },
        20_000,
        "every page reloads its artifact after an edit",
      );

      // An old page that cannot reach the server for longer than the server remembers it misses
      // the receipt and the edit. When it comes back it still shows the receipt and reloads.
      const oldPages = pages.filter((page) => page.legacy);
      for (const page of oldPages) {
        // The agent's reply ends the working state, so the page can send again.
        await fetch(`${base}/api/${page.key}/agent-reply`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ text: `done ${page.index}` }),
        });
      }
      await waitFor(
        async () => {
          const states = await Promise.all(oldPages.map(pageState));
          return states.every((state, i) => state?.chat.includes(`done ${oldPages[i].index}`)) || states;
        },
        20_000,
        "every old page gets the agent's reply",
      );
      for (const page of oldPages) {
        await evaluate(
          page,
          `(() => {
            document.getElementById("chatInput").value = "second feedback from page ${page.index}";
            document.getElementById("chatInput").dispatchEvent(new Event("input"));
            document.getElementById("send").click();
          })()`,
        );
      }
      await waitFor(
        async () => {
          const states = await Promise.all(oldPages.map(pageState));
          return states.every((state) => /Sent to Lavish/.test(state?.status || "")) || states;
        },
        20_000,
        "every old page shows its feedback as sent",
      );
      const blockEvents = [{ urlPattern: "*/chrome-client.js" }, { urlPattern: "*/events/*" }];
      for (const page of oldPages) {
        await chrome.send("Fetch.enable", { patterns: blockEvents }, page.sessionId);
      }
      // Let any poll already in flight finish, so the events below happen while the pages are away.
      await new Promise((resolve) => setTimeout(resolve, 1500));
      const awayFrames = await Promise.all(oldPages.map(pageState));
      for (const page of oldPages) {
        const delivery = await (
          await fetch(`${base}/api/poll?file=${encodeURIComponent(page.file)}&timeoutMs=0`)
        ).json();
        assert.equal(delivery.status, "feedback", JSON.stringify(delivery));
        await fetch(`${base}/api/${page.key}/feedback-ack`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ feedback_id: delivery.feedback_id }),
        });
        await writeFile(page.file, `<!doctype html><html><body><h1>Edited while away ${page.index}</h1></body></html>`);
      }
      await new Promise((resolve) => setTimeout(resolve, LEGACY_PAGE_TTL_MS + 2000));
      const whileAway = await Promise.all(oldPages.map(pageState));
      assert.deepEqual(
        whileAway.map((state) => state?.frameSrc),
        awayFrames.map((state) => state?.frameSrc),
        "the pages did not see the edit while away",
      );
      for (const page of oldPages) {
        await chrome.send("Fetch.enable", { patterns: [{ urlPattern: "*/chrome-client.js" }] }, page.sessionId);
      }
      await waitFor(
        async () => {
          const states = await Promise.all(oldPages.map(pageState));
          const behind = oldPages.filter(
            (_, i) => states[i]?.frameSrc === awayFrames[i]?.frameSrc || !/acknowledged/i.test(states[i]?.status || ""),
          );
          return (
            behind.length === 0 || {
              behind: behind.map((page) => page.index),
              statuses: states.map((state) => state?.status),
            }
          );
        },
        20_000,
        "every old page shows the receipt and reloads for the edit it missed",
      );

      // A server restart: socket pages reload once the new server is up; old pages reconnect.
      await server.close();
      server = await serve({ port, stateFile, version: "live-e2e", idleTimeoutMs: null });
      await expectAgentReplyEverywhere("after restart");
    } finally {
      await chrome.close();
      await server.close();
      await rm(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    }
  },
);
