import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import { pathToFileURL } from "node:url";

import { freePort, launchChrome, waitFor } from "./chrome-cdp.js";

process.env.LAVISH_AXI_HOST = "127.0.0.1";
process.env.LAVISH_AXI_LINK_HOST = "127.0.0.1";

const { serve } = await import("../src/server.js");

// A review page shows the artifact in a sandboxed iframe. Full screen needs its own permission on
// that iframe, and Annotate mode must leave a video's own controls to the video.
const runBrowserE2e = process.env.LAVISH_AXI_BROWSER_E2E === "1";

// Records a short WebM clip in the browser, so the test needs no binary fixture.
const RECORD_CLIP = `(async () => {
  const canvas = document.createElement("canvas");
  canvas.width = 320;
  canvas.height = 180;
  const g = canvas.getContext("2d");
  const recorder = new MediaRecorder(canvas.captureStream(30), { mimeType: "video/webm" });
  const chunks = [];
  recorder.ondataavailable = (event) => chunks.push(event.data);
  let frame = 0;
  const timer = setInterval(() => {
    g.fillStyle = "hsl(" + ((frame * 12) % 360) + " 70% 45%)";
    g.fillRect(0, 0, 320, 180);
    g.fillStyle = "#fff";
    g.font = "48px sans-serif";
    g.fillText(String(frame++), 24, 110);
  }, 33);
  const stopped = new Promise((resolve) => (recorder.onstop = resolve));
  recorder.start();
  await new Promise((resolve) => setTimeout(resolve, 4000));
  recorder.stop();
  await stopped;
  clearInterval(timer);
  const bytes = new Uint8Array(await new Blob(chunks).arrayBuffer());
  let text = "";
  for (let i = 0; i < bytes.length; i += 1) text += String.fromCharCode(bytes[i]);
  return btoa(text);
})()`;

// Chrome's own names for the parts of a video's built-in controls.
const CONTROL = {
  play: "-webkit-media-controls-play-button",
  fullscreen: "-webkit-media-controls-fullscreen-button",
  timeline: "-webkit-media-controls-timeline",
};

describe("video players in a review page", { skip: !runBrowserE2e, timeout: 240_000 }, () => {
  /** @type {string} */
  let temp;
  /** @type {any} */
  let server;
  /** @type {http.Server} */
  let embed;
  /** @type {number} */
  let embedPort;
  /** @type {any} */
  let chrome;
  /** @type {string} */
  let sessionId;
  /** @type {string} */
  let base;
  /** @type {string} */
  let key;
  /** @type {Array<{ sessionId: string, contextId: number }>} */
  const contexts = [];

  before(async () => {
    temp = await mkdtemp(path.join(tmpdir(), "lavish-fullscreen-browser-"));
    const stateFile = path.join(temp, "state", "state.json");
    await mkdir(path.dirname(stateFile), { recursive: true });
    const fixedPort = Number(process.env.LAVISH_AXI_E2E_PORT);
    const port = fixedPort || (await freePort());
    server = await serve({ port, stateFile, version: "fullscreen-e2e", idleTimeoutMs: null });
    base = `http://127.0.0.1:${port}`;
    // A second origin, like a video embed from another site.
    embedPort = fixedPort ? fixedPort + 1 : await freePort();
    embed = http.createServer((_req, res) => {
      res.setHeader("content-type", "text/html");
      res.end("<!doctype html><title>embed</title><p>embedded player</p>");
    });
    await new Promise((resolve) => embed.listen(embedPort, "127.0.0.1", () => resolve(undefined)));

    chrome = await launchChrome(path.join(temp, "chrome"));
    const { targetId } = await chrome.send("Target.createTarget", { url: "about:blank" });
    ({ sessionId } = await chrome.send("Target.attachToTarget", { targetId, flatten: true }));
    await chrome.send(
      "Emulation.setDeviceMetricsOverride",
      { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false },
      sessionId,
    );

    const clip = await chrome.send(
      "Runtime.evaluate",
      { expression: RECORD_CLIP, awaitPromise: true, returnByValue: true },
      sessionId,
    );
    await writeFile(path.join(temp, "clip.webm"), Buffer.from(clip.result.value, "base64"));
    const file = path.join(temp, "index.html");
    // The page records every mouse press and click from the moment it starts, whether it reached
    // the page's own bubble phase, and whether anything cancelled it.
    await writeFile(
      file,
      `<!doctype html><html><body style="margin:24px">
<video id="clip" controls src="clip.webm" width="480" height="270"></video>
<iframe id="embed" src="http://localhost:${embedPort}/" allowfullscreen width="320" height="120"></iframe>
<script>
window.pageClicks = [];
for (const type of ["mousedown", "mouseup", "click"]) {
  addEventListener(type, (event) => {
    const entry = { type, reached: false };
    pageClicks.push(entry);
    event.lavishTestEntry = entry;
    setTimeout(() => (entry.cancelled = event.defaultPrevented));
  }, true);
  addEventListener(type, (event) => (event.lavishTestEntry.reached = true));
}
</script>
</body></html>`,
    );
    const opened = await (
      await fetch(`${base}/api/sessions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ file, url: "" }),
      })
    ).json();
    key = opened.key;

    // The artifact iframe can run in its own process, so collect every frame's main world.
    const autoAttach = { autoAttach: true, waitForDebuggerOnStart: false, flatten: true };
    chrome.onEvent((message) => {
      if (message.method === "Runtime.executionContextCreated" && message.params.context.auxData?.isDefault) {
        contexts.push({ sessionId: message.sessionId, contextId: message.params.context.id });
      }
      if (message.method === "Target.attachedToTarget") {
        const child = message.params.sessionId;
        chrome.send("Runtime.enable", {}, child).catch(() => {});
        chrome.send("Target.setAutoAttach", autoAttach, child).catch(() => {});
      }
    });
    await chrome.send("Target.setAutoAttach", autoAttach, sessionId);
    await chrome.send("Runtime.enable", {}, sessionId);
  });

  after(async () => {
    if (key) {
      await fetch(`${base}/api/${key}/end`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: base },
        body: "{}",
      }).catch(() => {});
    }
    await chrome?.close();
    await server?.close();
    if (embed) await new Promise((resolve) => embed.close(() => resolve(undefined)));
    if (temp) await rm(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  });

  const evaluateIn = async (ctx, expression, options = {}) => {
    const result = await chrome.send(
      "Runtime.evaluate",
      { expression, contextId: ctx.contextId, returnByValue: true, awaitPromise: true, ...options },
      ctx.sessionId,
    );
    if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
    return result.result?.value;
  };
  const inPage = (expression) => evaluateIn({ sessionId }, expression);
  const frameContext = async (urlPart) => {
    for (const ctx of [...contexts].reverse()) {
      const href = await evaluateIn(ctx, "location.href").catch(() => "");
      if (String(href).includes(urlPart)) return ctx;
    }
    return null;
  };

  const mouse = (type, { x, y }, button = "left") =>
    chrome.send(
      "Input.dispatchMouseEvent",
      { type, x, y, button, clickCount: type === "mouseMoved" ? 0 : 1 },
      sessionId,
    );
  const click = async (point) => {
    await mouse("mouseMoved", point, "none");
    await mouse("mousePressed", point);
    await mouse("mouseReleased", point);
  };
  // Presses at `from`, moves to `to` in steps with the button held, and releases there.
  const drag = async (from, to) => {
    await mouse("mouseMoved", from, "none");
    await mouse("mousePressed", from);
    for (let step = 1; step <= 5; step += 1) {
      await mouse("mouseMoved", { x: from.x + ((to.x - from.x) * step) / 5, y: from.y + ((to.y - from.y) * step) / 5 });
    }
    await mouse("mouseReleased", to);
  };

  // A video player in one document. `ctx` is the document's main world, and `offset` is where the
  // document sits on the page, so points it returns can go straight to Input.dispatchMouseEvent.
  const playerIn = (ctx, offset) => {
    const run = (expression, options = {}) => evaluateIn(ctx, expression, options);
    return {
      run,
      playing: () => run("!document.getElementById('clip').paused"),
      currentTime: () => run("document.getElementById('clip').currentTime"),
      fullscreenId: () => run("document.fullscreenElement?.id || 'none'"),
      pageClicks: () => run("window.pageClicks.splice(0)"),
      cardHeading: () =>
        run(
          `document.querySelector(".lavish-annotation-root")?.shadowRoot?.querySelector(".lavish-annotation-card .lavish-heading")?.textContent || ""`,
        ),
      async box() {
        const rect = JSON.parse(await run("JSON.stringify(document.getElementById('clip').getBoundingClientRect())"));
        return { ...rect, x: rect.x + offset.x, y: rect.y + offset.y };
      },
      // Where Chrome draws one part of the video's controls, read from its user-agent shadow DOM.
      async control(pseudo) {
        await chrome.send("DOM.enable", {}, ctx.sessionId);
        const { root } = await chrome.send("DOM.getDocument", { depth: -1, pierce: true }, ctx.sessionId);
        const find = (node) => {
          const attrs = node.attributes || [];
          const at = attrs.indexOf("pseudo");
          if (at >= 0 && attrs[at + 1] === pseudo) return node;
          for (const child of [...(node.children || []), ...(node.shadowRoots || [])]) {
            const hit = find(child);
            if (hit) return hit;
          }
          return null;
        };
        const node = find(root);
        assert.ok(node, `Chrome draws a ${pseudo}`);
        const { model } = await chrome.send("DOM.getBoxModel", { nodeId: node.nodeId }, ctx.sessionId);
        const [x1, y1, , , x2, y2] = model.border;
        return { left: x1 + offset.x, top: y1 + offset.y, right: x2 + offset.x, bottom: y2 + offset.y };
      },
      async controlCenter(pseudo) {
        const box = await this.control(pseudo);
        return { x: (box.left + box.right) / 2, y: (box.top + box.bottom) / 2 };
      },
    };
  };

  /** @param {ReturnType<typeof playerIn>} player */
  const waitReady = (player) =>
    waitFor(
      async () => (await player.run("document.getElementById('clip').readyState >= 1").catch(() => false)) || "loading",
      20_000,
      "the video loads",
    );

  // Opens the review page and returns the artifact's video player once the layout check reveals it.
  const openReviewPage = async () => {
    contexts.length = 0;
    await chrome.send("Page.navigate", { url: `${base}/session/${key}` }, sessionId);
    /** @type {any} */
    let artifact = null;
    await waitFor(
      async () => {
        artifact = await frameContext(`/artifact/${key}/`);
        if (!artifact) return "no artifact frame";
        const ready = await evaluateIn(artifact, "document.getElementById('clip')?.readyState >= 1").catch(() => false);
        return ready || "loading";
      },
      20_000,
      "the artifact frame loads the video",
    );
    // The layout check covers the artifact until its first pass, so wait for it before clicking.
    await waitFor(
      async () =>
        (await inPage("document.body.classList.contains('layout-gate-active')")) === false ||
        "layout check still covers the artifact",
      20_000,
      "the layout check reveals the artifact",
    );
    const frame = JSON.parse(
      await inPage("JSON.stringify(document.getElementById('artifact').getBoundingClientRect())"),
    );
    return { artifact, player: playerIn(artifact, { x: frame.x, y: frame.y }) };
  };

  // Drags the timeline from near its start to three quarters along, and returns where playback ends up.
  const seekByDragging = async (player) => {
    await player.run("document.getElementById('clip').currentTime = 0");
    await waitFor(async () => (await player.currentTime()) === 0 || "not at the start", 5000, "rewinds");
    const box = await player.box();
    // Pointing at the video shows its controls.
    await mouse("mouseMoved", { x: box.x + box.width / 2, y: box.y + box.height / 2 }, "none");
    const timeline = await player.control(CONTROL.timeline);
    const y = (timeline.top + timeline.bottom) / 2;
    const width = timeline.right - timeline.left;
    await drag({ x: timeline.left + width * 0.1, y }, { x: timeline.left + width * 0.75, y });
    const duration = await player.run("document.getElementById('clip').duration");
    let position = 0;
    await waitFor(
      async () => {
        position = await player.currentTime();
        return position > duration * 0.5 || `at ${position} of ${duration}`;
      },
      5000,
      "dragging the timeline moves the playback position",
    );
    return { position, duration };
  };

  // The checks every normal player passes: play, pause, seek and full screen from its own controls,
  // and a click on the picture that reaches the page uncancelled.
  const assertNormalPlayer = async (player) => {
    await click(await player.controlCenter(CONTROL.play));
    await waitFor(async () => (await player.playing()) || "paused", 5000, "the play button plays the video");
    await click(await player.controlCenter(CONTROL.play));
    await waitFor(async () => !(await player.playing()) || "playing", 5000, "the play button pauses the video");

    const seek = await seekByDragging(player);
    assert.ok(seek.position > seek.duration * 0.5, "the timeline seeks");

    await click(await player.controlCenter(CONTROL.fullscreen));
    await waitFor(
      async () => (await player.fullscreenId()) === "clip" || "not full screen",
      5000,
      "the full-screen button takes the video full screen",
    );
    await player.run("document.exitFullscreen()", { userGesture: true });
    await waitFor(async () => (await player.fullscreenId()) === "none" || "still full screen", 5000, "exits");

    // Chrome keeps mouse events on its built-in controls inside the player, so the page sees only
    // the click on the picture below, which is where Annotate mode could step in.
    await player.pageClicks();
    const box = await player.box();
    await click({ x: box.x + box.width / 2, y: box.y + box.height / 3 });
    await waitFor(async () => (await player.playing()) || "paused", 5000, "a click on the picture plays the video");
    await player.run("document.getElementById('clip').pause()");
    assert.equal(await player.cardHeading(), "", "no annotation starts");
    assert.deepEqual(
      await player.pageClicks(),
      ["mousedown", "mouseup", "click"].map((type) => ({ type, reached: true, cancelled: false })),
      "the click on the picture reaches the page and nothing cancels it",
    );
  };

  test("videos in a review page can go full screen and their controls work in Annotate mode", async () => {
    const { artifact, player } = await openReviewPage();

    assert.equal(
      await evaluateIn(artifact, "document.fullscreenEnabled"),
      true,
      "full screen is allowed in the artifact frame",
    );
    const embedded = await frameContext(`localhost:${embedPort}`);
    assert.ok(embedded, "the embedded frame loads");
    assert.equal(
      await evaluateIn(embedded, "document.fullscreenEnabled"),
      true,
      "full screen reaches a frame the artifact embeds from another origin",
    );

    const entered = await player.run(
      `document.getElementById("clip").requestFullscreen().then(
        () => document.fullscreenElement?.id || "none",
        (error) => "rejected: " + error.message,
      )`,
      { userGesture: true },
    );
    assert.equal(entered, "clip", "the video goes full screen");

    // Annotate mode is on by default. A full-screen video fills the screen, and an annotation card
    // could not show over it, so a click on the picture goes to the player.
    await click({ x: 640, y: 400 });
    await waitFor(async () => (await player.playing()) || "paused", 5000, "a click on a full-screen video plays it");
    assert.equal(await player.cardHeading(), "", "a click on a full-screen video does not start an annotation");
    await player.run("document.getElementById('clip').pause(); document.exitFullscreen()", { userGesture: true });
    await waitFor(async () => (await player.fullscreenId()) === "none" || "still full screen", 5000, "exits");

    await click(await player.controlCenter(CONTROL.play));
    await waitFor(async () => (await player.playing()) || "paused", 5000, "the play button plays the video");
    assert.equal(await player.cardHeading(), "", "the play button does not start an annotation");
    await player.run("document.getElementById('clip').pause()");

    const seek = await seekByDragging(player);
    assert.ok(seek.position > seek.duration * 0.5, "the timeline seeks in Annotate mode");
    assert.equal(await player.cardHeading(), "", "dragging the timeline does not start an annotation");

    await click(await player.controlCenter(CONTROL.fullscreen));
    await waitFor(
      async () => (await player.fullscreenId()) === "clip" || "not full screen",
      5000,
      "the full-screen button takes the video full screen",
    );
    assert.equal(await player.cardHeading(), "", "the full-screen button does not start an annotation");
    await player.run("document.exitFullscreen()", { userGesture: true });
    await waitFor(async () => (await player.fullscreenId()) === "none" || "still full screen", 5000, "exits");

    // A click on the picture, away from the controls, still annotates the video.
    await player.pageClicks();
    const box = await player.box();
    await click({ x: box.x + box.width / 2, y: box.y + box.height / 3 });
    await waitFor(
      async () => (await player.cardHeading()) === "Annotate <video>" || (await player.cardHeading()),
      5000,
      "a click on the picture annotates the video",
    );
    assert.equal(await player.playing(), false, "annotating the video does not play it");
    const taken = (await player.pageClicks()).find((entry) => entry.type === "click");
    assert.deepEqual(taken, { type: "click", reached: false, cancelled: true }, "Annotate mode takes the click");
  });

  test("with Annotate off, a video in a review page is a normal player", async () => {
    const { player } = await openReviewPage();
    const toggle = JSON.parse(
      await inPage("JSON.stringify(document.getElementById('annotation').getBoundingClientRect())"),
    );
    await click({ x: toggle.x + toggle.width / 2, y: toggle.y + toggle.height / 2 });
    assert.equal(await inPage("document.getElementById('annotation').getAttribute('aria-pressed')"), "false");

    await assertNormalPlayer(player);
  });

  test("a video in an exported copy is a normal player", async () => {
    const exported = await fetch(`${base}/api/${key}/export`);
    assert.equal(exported.status, 200);
    const html = await exported.text();
    assert.doesNotMatch(html, /sdk\.js/, "the export carries no Lavish SDK");
    const exportFile = path.join(temp, "export", "exported.html");
    await mkdir(path.dirname(exportFile), { recursive: true });
    await writeFile(exportFile, html);

    contexts.length = 0;
    await chrome.send("Page.navigate", { url: pathToFileURL(exportFile).href }, sessionId);
    const player = playerIn({ sessionId }, { x: 0, y: 0 });
    await waitReady(player);
    assert.equal(await player.run("document.fullscreenEnabled"), true, "full screen is allowed in the export");

    await assertNormalPlayer(player);
  });
});
