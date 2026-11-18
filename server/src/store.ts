// Linked Cosmos accounts: one bearer token per account and the devices (browsers) that relay it.
//
// The data is one JSON file (DATA_DIR/links.json, mode 600). The process keeps it in memory and
// writes the whole file again after each change: to a temporary file first, then a rename, so a
// crash never leaves half a file. Device keys are stored only as SHA-256 hashes.
//
// Never log a token or a device key.

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { constants } from "node:fs";
import { access, mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { join } from "node:path";

export interface Device {
  /** SHA-256 of the device key, hex. */
  keyHash: string;
  name: string;
  linkedAt: string;
  lastSeen: string;
}

export interface LinkedToken {
  token: string;
  /** Expiry of the token (the JWT "exp"), in seconds since 1970. */
  exp: number;
}

export interface Account {
  username: string;
  userId: string;
  token?: LinkedToken;
  devices: Device[];
}

interface FileData {
  version: 1;
  /** Key: the username in lower case. */
  accounts: Record<string, Account>;
}

export const MAX_DEVICES = 20;
/** A token that expires within this margin counts as expired. */
const EXPIRY_MARGIN_S = 60;
/** Write lastSeen at most this often, so each MCP request does not write the file. */
const LAST_SEEN_INTERVAL_MS = 60 * 60_000;
const DUMMY_HASH = createHash("sha256").update("no-device").digest("hex");

export function hashKey(key: string): string {
  return createHash("sha256").update(key, "utf8").digest("hex");
}

function sameHash(a: string, b: string): boolean {
  const left = Buffer.from(a, "hex");
  const right = Buffer.from(b, "hex");
  return left.length === right.length && timingSafeEqual(left, right);
}

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

export function isExpired(token: LinkedToken): boolean {
  return token.exp - EXPIRY_MARGIN_S <= nowSeconds();
}

export class TooManyDevicesError extends Error {}

export interface LinkResult {
  account: Account;
  deviceAdded: boolean;
  tokenUpdated: boolean;
}

export class LinkStore {
  readonly file: string;
  /** False when the data directory cannot be written. /link then answers 503. */
  writable = false;
  private data: FileData = { version: 1, accounts: {} };
  private writes: Promise<void> = Promise.resolve();

  constructor(readonly dir: string) {
    this.file = join(dir, "links.json");
  }

  async load(log: (fields: Record<string, unknown>) => void): Promise<void> {
    try {
      await mkdir(this.dir, { recursive: true, mode: 0o700 });
      await access(this.dir, constants.W_OK);
      this.writable = true;
    } catch (error) {
      log({ level: "error", event: "store_unwritable", dir: this.dir, error: (error as Error).message });
    }
    let text: string;
    try {
      text = await readFile(this.file, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        log({ level: "error", event: "store_unreadable", error: (error as Error).message });
      }
      return;
    }
    try {
      const parsed = JSON.parse(text) as FileData;
      if (parsed?.version !== 1 || typeof parsed.accounts !== "object" || parsed.accounts === null) {
        throw new Error("unknown format");
      }
      for (const account of Object.values(parsed.accounts)) {
        if (typeof account.username !== "string" || !Array.isArray(account.devices)) throw new Error("bad account");
      }
      this.data = parsed;
      log({ event: "store_loaded", accounts: Object.keys(parsed.accounts).length });
    } catch (error) {
      // A broken file only means that the devices must link again. Keep it aside for a look.
      const aside = `${this.file}.broken-${Date.now()}`;
      log({ level: "error", event: "store_broken", movedTo: aside, error: (error as Error).message });
      await rename(this.file, aside).catch(() => undefined);
    }
  }

  /** Writes the current data. Writes run one after the other. */
  save(): Promise<void> {
    const run = this.writes.then(() => this.writeFile());
    this.writes = run.catch(() => undefined);
    return run;
  }

  private async writeFile(): Promise<void> {
    const temporary = `${this.file}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
    const handle = await open(temporary, "wx", 0o600);
    try {
      await handle.writeFile(JSON.stringify(this.data, null, 2) + "\n", "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    try {
      await rename(temporary, this.file);
    } catch (error) {
      await unlink(temporary).catch(() => undefined);
      throw error;
    }
  }

  private saveInBackground(log: (fields: Record<string, unknown>) => void): void {
    this.save().catch((error: unknown) => log({ level: "error", event: "store_write_failed", error: (error as Error).message }));
  }

  account(username: string): Account | undefined {
    return this.data.accounts[username.toLowerCase()];
  }

  /**
   * Checks a device key for the vault of one username. The check takes about the same time for
   * a wrong key, an unknown username and a good key.
   */
  authenticate(username: string, key: string, log: (fields: Record<string, unknown>) => void): Account | undefined {
    const keyHash = hashKey(key);
    const account = this.account(username);
    let found: Device | undefined;
    for (const device of account?.devices ?? []) {
      if (sameHash(device.keyHash, keyHash) && !found) found = device;
    }
    if (!account) sameHash(DUMMY_HASH, keyHash);
    if (!account || !found) return undefined;
    if (Date.now() - Date.parse(found.lastSeen) > LAST_SEEN_INTERVAL_MS) {
      found.lastSeen = new Date().toISOString();
      this.saveInBackground(log);
    }
    return account;
  }

  /** The token of an account. An expired token is deleted here. */
  token(username: string, log: (fields: Record<string, unknown>) => void): LinkedToken | undefined {
    const account = this.account(username);
    if (!account?.token) return undefined;
    if (isExpired(account.token)) {
      delete account.token;
      log({ event: "token_expired", username: account.username });
      this.saveInBackground(log);
      return undefined;
    }
    return account.token;
  }

  /** Deletes a token that Cosmos refused, unless a newer token replaced it in the meantime. */
  dropToken(username: string, token: string, log: (fields: Record<string, unknown>) => void): void {
    const account = this.account(username);
    if (account?.token?.token !== token) return;
    delete account.token;
    log({ event: "token_refused", username: account.username });
    this.saveInBackground(log);
  }

  /**
   * Adds or refreshes a device and offers a token. Call only after Cosmos accepted the token.
   * A device key belongs to one account: it is removed from any other account.
   * The token replaces the stored one only when it expires later.
   */
  link(input: { username: string; userId: string; token: LinkedToken; deviceKey: string; deviceName: string }): LinkResult {
    const key = input.username.toLowerCase();
    const keyHash = hashKey(input.deviceKey);
    const now = new Date().toISOString();

    let account = this.data.accounts[key];
    const existing = account?.devices.find((device) => sameHash(device.keyHash, keyHash));
    if (!existing && (account?.devices.length ?? 0) >= MAX_DEVICES) {
      throw new TooManyDevicesError(`This account has ${MAX_DEVICES} linked devices. Unlink one first.`);
    }

    this.removeDeviceEverywhere(keyHash, key);
    if (!account) {
      account = { username: input.username, userId: input.userId, devices: [] };
      this.data.accounts[key] = account;
    }
    account.username = input.username;
    account.userId = input.userId;

    if (existing) {
      existing.name = input.deviceName;
      existing.lastSeen = now;
    } else {
      account.devices.push({ keyHash, name: input.deviceName, linkedAt: now, lastSeen: now });
    }

    const stored = account.token;
    const tokenUpdated = !stored || isExpired(stored) || input.token.exp > stored.exp;
    if (tokenUpdated) account.token = { token: input.token.token, exp: input.token.exp };
    return { account, deviceAdded: !existing, tokenUpdated };
  }

  /** Removes one device. An account without devices is deleted, with its token. */
  unlink(deviceKey: string): boolean {
    return this.removeDeviceEverywhere(hashKey(deviceKey));
  }

  private removeDeviceEverywhere(keyHash: string, exceptAccount?: string): boolean {
    let removed = false;
    for (const [key, account] of Object.entries(this.data.accounts)) {
      if (key === exceptAccount) continue;
      const before = account.devices.length;
      account.devices = account.devices.filter((device) => !sameHash(device.keyHash, keyHash));
      if (account.devices.length === before) continue;
      removed = true;
      if (account.devices.length === 0) delete this.data.accounts[key];
    }
    return removed;
  }
}

/** Reads "exp" from a JWT without checking its signature. Cosmos checks the token itself. */
export function jwtExpiry(token: string): number | undefined {
  const payload = token.split(".")[1];
  if (!payload) return undefined;
  try {
    const exp = (JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as { exp?: unknown }).exp;
    return typeof exp === "number" && Number.isFinite(exp) ? exp : undefined;
  } catch {
    return undefined;
  }
}
