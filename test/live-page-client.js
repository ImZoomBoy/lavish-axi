import WebSocket from "ws";

/**
 * A review page's live channel, as seen from outside the browser. `next(event)` resolves with the
 * data of the oldest unread message of that event type.
 *
 * @param {string} base server origin, such as http://127.0.0.1:1234
 * @param {string} key session key
 * @param {Record<string, string>} [headers]
 */
export function connectLivePage(base, key, headers = {}) {
  const socket = new WebSocket(`${base.replace(/^http/, "ws")}/live/${key}`, { headers });
  /** @type {Array<{ event: string, data: any }>} */
  const received = [];
  /** @type {Array<() => void>} */
  const waiters = [];
  socket.on("message", (raw) => {
    received.push(JSON.parse(String(raw)));
    for (const waiter of waiters.splice(0)) waiter();
  });
  socket.on("error", () => {});
  /** @type {Promise<number>} */
  const closed = new Promise((resolve) => socket.on("close", (code) => resolve(code)));
  /** @type {Promise<void>} */
  const opened = new Promise((resolve, reject) => {
    socket.once("open", () => resolve());
    socket.once("error", reject);
    socket.once("unexpected-response", (_req, res) => reject(new Error(`handshake refused: ${res.statusCode}`)));
  });
  opened.catch(() => {});
  return {
    socket,
    received,
    opened,
    closed,
    /**
     * @param {string} event
     * @param {number} [timeoutMs]
     */
    async next(event, timeoutMs = 2000) {
      const deadline = Date.now() + timeoutMs;
      while (true) {
        const index = received.findIndex((message) => message.event === event);
        if (index >= 0) return received.splice(index, 1)[0].data;
        const remaining = deadline - Date.now();
        if (remaining <= 0) throw new Error(`timed out waiting for ${event}; got ${JSON.stringify(received)}`);
        await new Promise((resolve) => {
          const timer = setTimeout(resolve, remaining);
          waiters.push(() => {
            clearTimeout(timer);
            resolve(undefined);
          });
        });
      }
    },
    async close() {
      if (socket.readyState !== WebSocket.CLOSED) socket.close();
      await closed;
    },
  };
}
