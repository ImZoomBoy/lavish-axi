import crypto from "node:crypto";

// Every emitter event a review page listens for, mapped to the payload the page receives.
const PAGE_EVENTS = {
  reload: () => ({}),
  "agent-reply": (text) => ({ text }),
  "agent-presence": (state) => ({ state }),
  "layout-warnings": (warnings) => ({ warnings }),
  "feedback-delivered": (feedbackId) => ({ feedback_id: feedbackId }),
  "feedback-acknowledged": (feedbackId) => ({ feedback_id: feedbackId }),
};

// Pages built before the WebSocket channel hold an EventSource on `/events/:key`. Chrome allows
// six HTTP/1.1 connections per host, so six held streams leave every further tab blank. Those
// pages are served as short polls instead: each request replays what the page missed and ends,
// and the EventSource reconnects after this delay, carrying its cursor in `Last-Event-ID`.
export const LEGACY_STREAM_RETRY_MS = 1000;
// A polling page counts as open while it has reconnected recently.
export const LEGACY_PAGE_TTL_MS = 5 * LEGACY_STREAM_RETRY_MS;
const REPLAY_LIMIT = 200;
// A snapshot read that overlaps an event for its session is read again, so the page's cursor sits
// after everything the snapshot shows. The last attempt keeps the earlier cursor instead, which
// can repeat an event but never skips one.
const SNAPSHOT_ATTEMPTS = 3;

/**
 * What a polling page missed that a snapshot of current state cannot show, because it is a
 * one-off signal: an artifact reload, or the agent's receipt for delivered feedback.
 *
 * @typedef {{ reload: boolean, acknowledgedFeedbackId: string | null, acknowledgedSince: number | null }} LegacyCatchUp
 */

/**
 * Fans session events out to open review pages. Each emitter event gets exactly one listener,
 * however many pages are open, so the listener count never grows with pages.
 *
 * @param {import("node:events").EventEmitter} events
 * @param {{ now?: () => number }} [options]
 */
export function createLivePages(events, { now = Date.now } = {}) {
  const bootId = crypto.randomBytes(6).toString("hex");
  /** @type {Map<string, Set<{ send: (event: string, data: unknown) => void, close: () => void }>>} */
  const socketsByKey = new Map();
  /** @type {Map<string, { key: string, seenAt: number }>} */
  const legacyPages = new Map();
  /** @type {Map<string, { droppedThrough: number, entries: Array<{ seq: number, event: string, data: unknown }> }>} */
  const replayByKey = new Map();
  // The last sequence number raised for each session, and the last reload and receipt, so a
  // page that resyncs can be told what it missed.
  /** @type {Map<string, number>} */
  const lastSeqByKey = new Map();
  /** @type {Map<string, number>} */
  const lastReloadByKey = new Map();
  /** @type {Map<string, { seq: number, feedbackId: string }>} */
  const lastAcknowledgedByKey = new Map();
  let seq = 0;

  for (const [event, toData] of Object.entries(PAGE_EVENTS)) {
    events.on(event, (key, ...args) => {
      const data = toData(...args);
      seq += 1;
      lastSeqByKey.set(key, seq);
      if (event === "reload") lastReloadByKey.set(key, seq);
      if (event === "feedback-acknowledged") lastAcknowledgedByKey.set(key, { seq, feedbackId: String(args[0]) });
      remember(key, { seq, event, data });
      for (const page of socketsByKey.get(key) || []) page.send(event, data);
    });
  }

  function pruneLegacyPages() {
    const cutoff = now() - LEGACY_PAGE_TTL_MS;
    for (const [clientId, page] of legacyPages) {
      if (page.seenAt < cutoff) legacyPages.delete(clientId);
    }
    for (const key of replayByKey.keys()) {
      if (![...legacyPages.values()].some((page) => page.key === key)) replayByKey.delete(key);
    }
  }

  // Events are kept only for sessions with a polling page, and only as many as a page could
  // miss between two polls. A page whose cursor predates the kept window gets a full resync.
  function remember(key, entry) {
    pruneLegacyPages();
    const replay = replayByKey.get(key);
    if (!replay) return;
    replay.entries.push(entry);
    while (replay.entries.length > REPLAY_LIMIT) {
      const dropped = replay.entries.shift();
      if (dropped) replay.droppedThrough = dropped.seq;
    }
  }

  function socketCount() {
    let count = 0;
    for (const pages of socketsByKey.values()) count += pages.size;
    return count;
  }

  return {
    /** Open pages on either channel. `/health` reports this as `live.pages`. */
    count() {
      pruneLegacyPages();
      return socketCount() + legacyPages.size;
    },

    /** Pages holding a WebSocket. Only these hold a connection open. */
    socketCount,

    /**
     * @param {string} key
     * @param {{ send: (event: string, data: unknown) => void, close: () => void }} page
     * @returns {() => void} removes the page
     */
    addSocket(key, page) {
      let pages = socketsByKey.get(key);
      if (!pages) {
        pages = new Set();
        socketsByKey.set(key, pages);
      }
      pages.add(page);
      return () => {
        const current = socketsByKey.get(key);
        if (!current) return;
        current.delete(page);
        if (current.size === 0) socketsByKey.delete(key);
      };
    },

    /** Every open WebSocket page, for shutdown. */
    sockets() {
      return [...socketsByKey.values()].flatMap((pages) => [...pages]);
    },

    /**
     * Answers one poll from an EventSource page with what it missed. A page whose cursor is
     * unknown, from another server run, or older than the kept events gets a snapshot from
     * `readSnapshot` instead, plus the reload and receipt it missed since that cursor.
     *
     * @param {string} key
     * @param {string | undefined} lastEventId
     * @param {(catchUp: LegacyCatchUp | null) => Promise<Array<{ event: string, data: unknown }>>} readSnapshot
     *   `catchUp` is null for a page without a cursor, which is a freshly loaded page.
     * @returns {Promise<{ frames: Array<{ event: string, data: unknown }>, cursor: string }>}
     */
    async pollLegacy(key, lastEventId, readSnapshot) {
      pruneLegacyPages();
      const cursor = parseCursor(lastEventId);
      const clientId = cursor?.clientId || crypto.randomBytes(12).toString("base64url");
      const sameRun = Boolean(cursor && cursor.bootId === bootId && cursor.seq <= seq);
      const known = sameRun ? legacyPages.get(clientId) : undefined;
      const replay = replayByKey.get(key);
      legacyPages.set(clientId, { key, seenAt: now() });
      if (!replayByKey.has(key)) replayByKey.set(key, { droppedThrough: seq, entries: [] });

      if (cursor && known && known.key === key && replay && cursor.seq >= replay.droppedThrough) {
        return {
          frames: replay.entries.filter((entry) => entry.seq > cursor.seq).map(({ event, data }) => ({ event, data })),
          cursor: formatCursor(clientId, seq, now()),
        };
      }

      for (let attempt = 1; ; attempt += 1) {
        // Take the cursor before reading, so an event raised during the read is replayed on the
        // next poll rather than lost.
        const startSeq = seq;
        const startTime = now();
        const frames = await readSnapshot(cursor ? catchUpSince(key, cursor, sameRun) : null);
        if ((lastSeqByKey.get(key) || 0) <= startSeq || attempt === SNAPSHOT_ATTEMPTS) {
          return { frames, cursor: formatCursor(clientId, startSeq, startTime) };
        }
      }
    },
  };

  /**
   * @param {string} key
   * @param {{ seq: number, time: number | null }} cursor
   * @param {boolean} sameRun
   * @returns {LegacyCatchUp}
   */
  function catchUpSince(key, cursor, sameRun) {
    if (!sameRun) {
      // Events from another server run are gone. Reload in case the artifact changed, and let
      // the caller find a receipt in stored state newer than the cursor.
      return { reload: true, acknowledgedFeedbackId: null, acknowledgedSince: cursor.time ?? 0 };
    }
    const acknowledged = lastAcknowledgedByKey.get(key);
    return {
      reload: (lastReloadByKey.get(key) || 0) > cursor.seq,
      acknowledgedFeedbackId: acknowledged && acknowledged.seq > cursor.seq ? acknowledged.feedbackId : null,
      acknowledgedSince: null,
    };
  }

  function formatCursor(clientId, cursorSeq, time) {
    return `${bootId}.${clientId}.${cursorSeq}.${time}`;
  }
}

function parseCursor(value) {
  const match = /^([0-9a-f]{12})\.([A-Za-z0-9_-]{16})\.(\d+)(?:\.(\d+))?$/.exec(String(value || ""));
  if (!match) return null;
  return { bootId: match[1], clientId: match[2], seq: Number(match[3]), time: match[4] ? Number(match[4]) : null };
}

/** One server-sent event frame, as `/events/:key` writes it. */
export function formatStreamEvent(event, data, id = "") {
  return `${id ? `id: ${id}\n` : ""}event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}
