// A small fixed-window rate limit per client IP, kept in memory.

import type { IncomingMessage } from "node:http";

const MAX_KEYS = 10_000;

export class RateLimiter {
  private windows = new Map<string, { count: number; resetAt: number }>();

  constructor(
    readonly limit: number,
    readonly windowMs: number,
  ) {}

  /** Counts one event. Returns false when the key is over the limit. */
  hit(key: string): boolean {
    const window = this.current(key, true);
    window.count += 1;
    return window.count <= this.limit;
  }

  /** True while the key is over the limit. Does not count an event. */
  blocked(key: string): boolean {
    return this.current(key, false).count >= this.limit;
  }

  private current(key: string, create: boolean): { count: number; resetAt: number } {
    const now = Date.now();
    let window = this.windows.get(key);
    if (!window || window.resetAt <= now) {
      window = { count: 0, resetAt: now + this.windowMs };
      if (!create) return window;
      if (this.windows.size >= MAX_KEYS) this.prune(now);
      this.windows.set(key, window);
    }
    return window;
  }

  private prune(now: number): void {
    for (const [key, window] of this.windows) {
      if (window.resetAt <= now) this.windows.delete(key);
    }
    // Still full: drop the oldest entries.
    for (const key of this.windows.keys()) {
      if (this.windows.size < MAX_KEYS) break;
      this.windows.delete(key);
    }
  }
}

/**
 * The client IP. Behind the Dokploy proxy (Traefik), the last X-Forwarded-For entry is the address
 * that the proxy saw. Set TRUST_PROXY=0 when the server is reachable without a proxy.
 */
export function clientIp(req: IncomingMessage): string {
  if (process.env.TRUST_PROXY !== "0") {
    const header = req.headers["x-forwarded-for"];
    const value = Array.isArray(header) ? header.join(",") : header;
    const last = value?.split(",").map((part) => part.trim()).filter(Boolean).pop();
    if (last) return last;
  }
  return req.socket.remoteAddress ?? "unknown";
}
