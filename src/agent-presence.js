// How long a session may read "working" with no poll attached before the page stops waiting on
// the agent. Without it, an agent that takes a batch and never polls again blocks sends forever.
export const AGENT_QUIET_AFTER_MS = 2 * 60 * 1000;

/**
 * The agent-presence state of every session, as the review pages see it:
 * - `listening` while a poll is attached,
 * - `working` after a poll delivered a batch and released,
 * - `quiet` once `working` has lasted `quietAfterMs` with no poll attached,
 * - `waiting` otherwise.
 *
 * The server owns the quiet timeout, not the page, so every open page, a page opened later, and
 * a polling page from an older build all read the same state. Each change is emitted as an
 * `agent-presence` event.
 *
 * @param {import("node:events").EventEmitter} events
 * @param {{ quietAfterMs?: number }} [options]
 */
export function createAgentPresence(events, { quietAfterMs = AGENT_QUIET_AFTER_MS } = {}) {
  /** @type {Map<string, number>} */
  const activePolls = new Map();
  /** Sessions whose delivered batch has not been concluded, and whether the agent went quiet. */
  /** @type {Map<string, { quiet: boolean, timer: ReturnType<typeof setTimeout> | null }>} */
  const delivered = new Map();

  /** @param {string} key */
  function state(key) {
    if (activePolls.has(key)) return "listening";
    const batch = delivered.get(key);
    if (batch) return batch.quiet ? "quiet" : "working";
    return "waiting";
  }

  /** @param {string} key */
  function stopTimer(key) {
    const batch = delivered.get(key);
    if (batch?.timer) clearTimeout(batch.timer);
    if (batch) batch.timer = null;
  }

  // The quiet clock runs only while the page reads "working", so it counts from the moment the
  // page entered "working" with no poll attached.
  /** @param {string} key */
  function startTimerIfWorking(key) {
    const batch = delivered.get(key);
    if (!batch || batch.quiet || batch.timer || activePolls.has(key)) return;
    batch.timer = setTimeout(() => {
      batch.timer = null;
      change(key, () => {
        batch.quiet = true;
      });
    }, quietAfterMs);
    batch.timer.unref?.();
  }

  /**
   * @param {string} key
   * @param {() => void} mutate
   */
  function change(key, mutate) {
    const previous = state(key);
    mutate();
    startTimerIfWorking(key);
    const next = state(key);
    if (next !== previous) events.emit("agent-presence", key, next);
  }

  /** @param {string} key */
  function clearDelivered(key) {
    stopTimer(key);
    delivered.delete(key);
  }

  return {
    state,
    /** Attached polls across all sessions, for `/health` and idle shutdown. */
    pollCount() {
      let polls = 0;
      for (const count of activePolls.values()) polls += count;
      return polls;
    },
    /** @param {string} key */
    pollAttached(key) {
      change(key, () => {
        activePolls.set(key, (activePolls.get(key) || 0) + 1);
        clearDelivered(key);
      });
    },
    /** @param {string} key */
    pollReleased(key) {
      const count = activePolls.get(key) || 0;
      if (count === 0) return;
      change(key, () => {
        if (count === 1) activePolls.delete(key);
        else activePolls.set(key, count - 1);
      });
    },
    // A delivery or an ack (re)starts "working" and its quiet clock: both show the agent is
    // still there.
    /** @param {string} key */
    markWorking(key) {
      change(key, () => {
        stopTimer(key);
        delivered.set(key, { quiet: false, timer: null });
      });
    },
    /** An agent reply, a session end, or a reopen concludes the delivered batch. */
    /** @param {string} key */
    clear(key) {
      change(key, () => clearDelivered(key));
    },
    close() {
      for (const key of delivered.keys()) stopTimer(key);
    },
  };
}
