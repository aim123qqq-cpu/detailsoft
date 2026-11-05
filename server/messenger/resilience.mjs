// Staying on line with a messenger. The connection breaks now and then, more so through a proxy: a short break
// costs nothing (the messenger keeps updates until the next poll), so it is retried quietly and only counted.
// What a person would notice is reported: a long outage, a bot started twice, a token the messenger refuses.

export const POLL_TIMEOUT_MS = 40_000; // the long poll waits 25 s itself: longer than that the connection is dead
export const SEND_TIMEOUT_MS = 10_000;
const POLL_RETRY_MS = [1000, 2000, 5000, 10_000, 30_000];
const SEND_RETRY_MS = [1000, 3000];
const QUIET_MS = 60_000;
const REPEAT_MS = 10 * 60_000;
const SUMMARY_MS = 60 * 60_000;
const CONFLICTS_TO_REPORT = 3;

export const wait = (ms) => new Promise((resolve) => { setTimeout(resolve, ms).unref?.(); });

/** Ends a request that hangs: the abort of the whole bot, or its own time running out. */
export function requestSignal(ms, parent) {
  const timeout = AbortSignal.timeout(ms);
  return parent ? AbortSignal.any([parent, timeout]) : timeout;
}

/** The message with the reason fetch hides in `cause` (ECONNRESET, ETIMEDOUT…): that is what tells causes apart. */
export function describeFailure(error) {
  const message = String(error?.message ?? error);
  const code = error?.cause?.code ?? error?.code;
  return code && !message.includes(code) ? `${message} (${code})` : message;
}

/** No answer, a server error or "too many requests" may pass; a clear refusal will be the same next time. */
const worthRetrying = (error) => error?.status === undefined || error.status === 429 || error.status >= 500;

/** Repeats a send over a short break, so a person still gets the sign-in prompt or the reminder. */
export async function sendWithRetry(send, delays = SEND_RETRY_MS) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await send();
    } catch (error) {
      if (attempt >= delays.length || !worthRetrying(error)) throw error;
      await wait(Math.max(delays[attempt], (error.retryAfter ?? 0) * 1000));
    }
  }
}

/** Watches one bot's polling: says how long to wait after a failure and what is worth telling about it. */
export function createPollWatch({ provider, logger = console, delays = POLL_RETRY_MS, quietMs = QUIET_MS, repeatMs = REPEAT_MS, summaryMs = SUMMARY_MS, onDown, onUp, now = Date.now }) {
  let since = null;
  let failures = 0;
  let lastFailure = '';
  let reportedAt = null;
  let down = false;
  let conflicts = [];
  let conflictReportedAt = null;
  let shortBreaks = 0;
  let lastBreak = '';
  let summaryAt = now();

  return {
    failed(error) {
      const time = now();
      since ??= time;
      failures += 1;
      lastFailure = describeFailure(error);
      const due = (at) => at === null || time - at >= repeatMs;
      if (error?.status === 409) {
        // Two bots with one token take turns stealing the updates, so successes mix in: counted over time, not in a row.
        conflicts = [...conflicts.filter((at) => time - at < repeatMs), time];
        if (conflicts.length >= CONFLICTS_TO_REPORT && due(conflictReportedAt)) {
          logger.error(`${provider} polling conflict:`, lastFailure);
          conflictReportedAt = time;
        }
      } else if (error?.status === 401 || error?.status === 403 || error?.status === 404) {
        if (due(reportedAt)) { logger.error(`${provider} polling refused:`, lastFailure); reportedAt = time; }
      } else if (time - since >= quietMs && due(reportedAt)) {
        logger.error(`${provider} polling failed for ${Math.round((time - since) / 1000)} s:`, lastFailure);
        reportedAt = time;
      }
      if (!down && time - since >= quietMs) { down = true; onDown?.(lastFailure); }
      const delay = delays[Math.min(failures - 1, delays.length - 1)];
      return Math.max(delay, (error?.retryAfter ?? 0) * 1000);
    },
    ok() {
      const time = now();
      if (since !== null) {
        if (reportedAt !== null) logger.log(`${provider} polling recovered after ${Math.round((time - since) / 1000)} s`);
        else { shortBreaks += 1; lastBreak = lastFailure; }
        if (down) onUp?.();
        since = null; failures = 0; reportedAt = null; down = false;
      }
      if (shortBreaks && time - summaryAt >= summaryMs) {
        logger.log(`${provider} polling had ${shortBreaks} short breaks, last: ${lastBreak}`);
        shortBreaks = 0;
        summaryAt = time;
      }
    }
  };
}
