import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

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
  await new Promise((resolve) => setTimeout(resolve, 2500));
  recorder.stop();
  await stopped;
  clearInterval(timer);
  const bytes = new Uint8Array(await new Blob(chunks).arrayBuffer());
  let text = "";
  for (let i = 0; i < bytes.length; i += 1) text += String.fromCharCode(bytes[i]);
  return btoa(text);
})()`;

test(
  "videos in a review page can go full screen and their controls work in Annotate mode",
  { skip: !runBrowserE2e, timeout: 120_000 },
  async () => {
    const temp = await mkdtemp(path.join(tmpdir(), "lavish-fullscreen-browser-"));
    const stateFile = path.join(temp, "state", "state.json");
    await mkdir(path.dirname(stateFile), { recursive: true });
    const port = Number(process.env.LAVISH_AXI_E2E_PORT) || (await freePort());
    const server = await serve({ port, stateFile, version: "fullscreen-e2e", idleTimeoutMs: null });
    const base = `http://127.0.0.1:${port}`;
    // A second origin, like a video embed from another site.
    const embedPort = await freePort();
    const embed = http.createServer((_req, res) => {
      res.setHeader("content-type", "text/html");
      res.end("<!doctype html><title>embed</title><p>embedded player</p>");
    });
    await new Promise((resolve) => embed.listen(embedPort, "127.0.0.1", () => resolve(undefined)));
    /** @type {any} */
    let chrome;

    try {
      chrome = await launchChrome(path.join(temp, "chrome"));
      const { targetId } = await chrome.send("Target.createTarget", { url: "about:blank" });
      const { sessionId } = await chrome.send("Target.attachToTarget", { targetId, flatten: true });
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
      await writeFile(
        file,
        `<!doctype html><html><body style="margin:24px">
<video id="clip" controls src="clip.webm" width="480" height="270"></video>
<iframe id="embed" src="http://localhost:${embedPort}/" allowfullscreen width="320" height="120"></iframe>
</body></html>`,
      );
      const opened = await (
        await fetch(`${base}/api/sessions`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ file, url: "" }),
        })
      ).json();

      // The artifact iframe can run in its own process, so collect every frame's main world.
      /** @type {Array<{ sessionId: string, contextId: number }>} */
      const contexts = [];
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
      await chrome.send("Page.navigate", { url: `${base}/session/${opened.key}` }, sessionId);

      const evaluateIn = async (ctx, expression, options = {}) => {
        const result = await chrome.send(
          "Runtime.evaluate",
          { expression, contextId: ctx.contextId, returnByValue: true, awaitPromise: true, ...options },
          ctx.sessionId,
        );
        if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
        return result.result?.value;
      };
      const frameContext = async (urlPart) => {
        for (const ctx of [...contexts].reverse()) {
          const href = await evaluateIn(ctx, "location.href").catch(() => "");
          if (String(href).includes(urlPart)) return ctx;
        }
        return null;
      };

      /** @type {any} */
      let artifact = null;
      await waitFor(
        async () => {
          artifact = await frameContext(`/artifact/${opened.key}/`);
          if (!artifact) return "no artifact frame";
          const ready = await evaluateIn(artifact, "document.getElementById('clip')?.readyState >= 1").catch(
            () => false,
          );
          return ready || "loading";
        },
        20_000,
        "the artifact frame loads the video",
      );

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

      // The layout check covers the artifact until its first pass, so wait for it before clicking.
      await waitFor(
        async () => {
          const gate = await chrome.send(
            "Runtime.evaluate",
            { expression: "document.body.classList.contains('layout-gate-active')", returnByValue: true },
            sessionId,
          );
          return gate.result.value === false || "layout check still covers the artifact";
        },
        20_000,
        "the layout check reveals the artifact",
      );

      const entered = await evaluateIn(
        artifact,
        `document.getElementById("clip").requestFullscreen().then(
          () => document.fullscreenElement?.id || "none",
          (error) => "rejected: " + error.message,
        )`,
        { userGesture: true },
      );
      assert.equal(entered, "clip", "the video goes full screen");

      const click = async (x, y) => {
        for (const type of ["mouseMoved", "mousePressed", "mouseReleased"]) {
          const pressed = type !== "mouseMoved";
          await chrome.send(
            "Input.dispatchMouseEvent",
            { type, x, y, button: pressed ? "left" : "none", clickCount: pressed ? 1 : 0 },
            sessionId,
          );
        }
      };
      const playing = () => evaluateIn(artifact, "!document.getElementById('clip').paused");
      const cardHeading = () =>
        evaluateIn(
          artifact,
          `document.querySelector(".lavish-annotation-root")?.shadowRoot?.querySelector(".lavish-annotation-card .lavish-heading")?.textContent || ""`,
        );

      // Annotate mode is on by default. A full-screen video fills the screen, and an annotation card
      // could not show over it, so a click on the picture goes to the player.
      await click(640, 400);
      await waitFor(async () => (await playing()) || "paused", 5000, "a click on a full-screen video plays it");
      assert.equal(await cardHeading(), "", "a click on a full-screen video does not start an annotation");
      await evaluateIn(artifact, "document.getElementById('clip').pause(); document.exitFullscreen()", {
        userGesture: true,
      });
      await waitFor(
        async () => (await evaluateIn(artifact, "!document.fullscreenElement")) || "still full screen",
        5000,
        "full screen exits",
      );

      const frameRect = await chrome.send(
        "Runtime.evaluate",
        {
          expression: "JSON.stringify(document.getElementById('artifact').getBoundingClientRect())",
          returnByValue: true,
        },
        sessionId,
      );
      const frame = JSON.parse(frameRect.result.value);
      const video = JSON.parse(
        await evaluateIn(artifact, "JSON.stringify(document.getElementById('clip').getBoundingClientRect())"),
      );
      // Chrome draws the control row 49px above the video's bottom edge: play 24px in from the
      // left, full screen 72px in from the right.
      const controlRow = frame.y + video.y + video.height - 49;

      await click(frame.x + video.x + 24, controlRow);
      await waitFor(async () => (await playing()) || "paused", 5000, "the play button plays the video");
      assert.equal(await cardHeading(), "", "the play button does not start an annotation");
      await evaluateIn(artifact, "document.getElementById('clip').pause()");

      await click(frame.x + video.x + video.width - 72, controlRow);
      await waitFor(
        async () =>
          (await evaluateIn(artifact, "document.fullscreenElement?.id || 'none'")) === "clip" || "not full screen",
        5000,
        "the full-screen button takes the video full screen",
      );
      assert.equal(await cardHeading(), "", "the full-screen button does not start an annotation");
      await evaluateIn(artifact, "document.exitFullscreen()", { userGesture: true });
      await waitFor(
        async () => (await evaluateIn(artifact, "!document.fullscreenElement")) || "still full screen",
        5000,
        "full screen exits",
      );

      // A click on the picture, away from the controls, still annotates the video.
      await click(frame.x + video.x + video.width / 2, frame.y + video.y + video.height / 3);
      await waitFor(
        async () => (await cardHeading()) === "Annotate <video>" || (await cardHeading()),
        5000,
        "a click on the picture annotates the video",
      );
      assert.equal(await playing(), false, "annotating the video does not play it");
    } finally {
      await chrome?.close();
      await server.close();
      await new Promise((resolve) => embed.close(() => resolve(undefined)));
      await rm(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    }
  },
);
