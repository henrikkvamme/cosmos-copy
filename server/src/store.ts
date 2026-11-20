// Linked Cosmos accounts: one bearer token per account, the devices (browsers) that relay it, and
// the signed-in users (Better Auth user ids) that may use it.
//
// An account is keyed by the Cosmos user id. Cosmos lets a person change the username, and a free
// username can go to another person, so the username is never an identity.
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
  /** The present Cosmos username. Display and the key route only. */
  username: string;
  /** The Cosmos user id: the identity of the account and the owner key of its data. */
  userId: string;
  token?: LinkedToken;
  devices: Device[];
  /** The signed-in users (Better Auth user ids) that linked this account. */
  users: string[];
}

interface FileData {
  version: 2;
  /** Key: the Cosmos user id. */
  accounts: Record<string, Account>;
  /**
   * Username (lower case) to Cosmos user id of the accounts of a version 1 file, while their pick
   * data has not moved to the user id yet. It stays in the file until the move is complete, so a
   * crash or a failed move is taken up again at the next start.
   */
  legacy?: Record<string, string>;
}

/** A connect ticket: the right to link the account of one device to the user who confirms. */
interface Ticket {
  keyHash: string;
  userId: string;
  expires: number;
}

const TICKET_TTL_MS = 10 * 60_000;
const MAX_TICKETS = 1_000;

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
  private data: FileData = { version: 2, accounts: {} };
  private writes: Promise<void> = Promise.resolve();
  private confirms: Promise<void> = Promise.resolve();
  /** Connect tickets by the SHA-256 hash of the ticket. In memory only: a restart ends them. */
  private readonly tickets = new Map<string, Ticket>();
  /**
   * Username (lower case) to Cosmos user id for the accounts of a version 1 file. The pick data of
   * such an account was stored under the username and must move to the user id.
   */
  legacyOwners = new Map<string, string>();
  /** Accounts that were deleted in memory. Their other data goes after the next write of the file. */
  private readonly dropped: string[] = [];
  /** Called with the Cosmos user id of each account whose deletion is on disk, so its other data can go. */
  onAccountDeleted: (userId: string) => void = () => undefined;

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
      const parsed = JSON.parse(text) as { version?: unknown; accounts?: Record<string, Account>; legacy?: Record<string, string> };
      if ((parsed?.version !== 1 && parsed?.version !== 2) || typeof parsed.accounts !== "object" || parsed.accounts === null) {
        throw new Error("unknown format");
      }
      const accounts: Record<string, Account> = {};
      for (const account of Object.values(parsed.accounts)) {
        if (typeof account.username !== "string" || typeof account.userId !== "string" || !account.userId || !Array.isArray(account.devices)) {
          throw new Error("bad account");
        }
        if (accounts[account.userId]) throw new Error("two accounts with one user id");
        accounts[account.userId] = { ...account, users: Array.isArray(account.users) ? account.users : [] };
        // Version 1 kept the pick data under the username.
        if (parsed.version === 1) this.legacyOwners.set(account.username.toLowerCase(), account.userId);
      }
      if (parsed.version === 2 && parsed.legacy && typeof parsed.legacy === "object") {
        for (const [name, userId] of Object.entries(parsed.legacy)) if (typeof userId === "string") this.legacyOwners.set(name, userId);
      }
      this.data = { version: 2, accounts, ...(this.legacyOwners.size ? { legacy: Object.fromEntries(this.legacyOwners) } : {}) };
      log({ event: "store_loaded", accounts: Object.keys(accounts).length, version: parsed.version });
      if (parsed.version === 1 && this.writable) await this.save();
    } catch (error) {
      // A broken file only means that the devices must link again. Keep it aside for a look.
      const aside = `${this.file}.broken-${Date.now()}`;
      log({ level: "error", event: "store_broken", movedTo: aside, error: (error as Error).message });
      await rename(this.file, aside).catch(() => undefined);
    }
  }

  /** The pick data of the version 1 accounts has moved: forget the usernames they were stored under. */
  async finishMigration(): Promise<void> {
    if (!this.data.legacy) return;
    delete this.data.legacy;
    this.legacyOwners.clear();
    await this.save();
  }

  /** Writes the current data. Writes run one after the other. */
  save(): Promise<void> {
    const run = this.writes.then(() => this.writeFile());
    this.writes = run.catch(() => undefined);
    return run;
  }

  private async writeFile(): Promise<void> {
    const text = JSON.stringify(this.data, null, 2) + "\n";
    const dropped = this.dropped.splice(0);
    try {
      await writeFileAtomic(this.file, text);
    } catch (error) {
      this.dropped.unshift(...dropped);
      throw error;
    }
    // The file no longer has these accounts, so their other data can go. Before the write a
    // restart would bring the account back, and its data must then still be there.
    for (const userId of dropped) if (!this.data.accounts[userId]) this.onAccountDeleted(userId);
  }

  /** The signed-in users of all accounts. */
  linkedUsers(): string[] {
    return [...new Set(Object.values(this.data.accounts).flatMap((account) => account.users))];
  }

  private saveInBackground(log: (fields: Record<string, unknown>) => void): void {
    this.save().catch((error: unknown) => log({ level: "error", event: "store_write_failed", error: (error as Error).message }));
  }

  /** The account of a Cosmos user id. */
  account(userId: string): Account | undefined {
    return this.data.accounts[userId];
  }

  /** The account that a signed-in user linked. */
  accountOfUser(authUserId: string): Account | undefined {
    return Object.values(this.data.accounts).find((account) => account.users.includes(authUserId));
  }

  /**
   * Checks a device key for the vault of one username. The check takes about the same time for
   * a wrong key, an unknown username and a good key.
   */
  authenticate(username: string, key: string, log: (fields: Record<string, unknown>) => void): Account | undefined {
    const keyHash = hashKey(key);
    const name = username.toLowerCase();
    let account: Account | undefined;
    let found: Device | undefined;
    let compared = false;
    // A device key belongs to one account. The username in the URL must be the present username of that account.
    for (const candidate of Object.values(this.data.accounts)) {
      if (candidate.username.toLowerCase() !== name) continue;
      for (const device of candidate.devices) {
        compared = true;
        if (sameHash(device.keyHash, keyHash) && !found) {
          found = device;
          account = candidate;
        }
      }
    }
    if (!compared) sameHash(DUMMY_HASH, keyHash);
    if (!account || !found) return undefined;
    if (Date.now() - Date.parse(found.lastSeen) > LAST_SEEN_INTERVAL_MS) {
      found.lastSeen = new Date().toISOString();
      this.saveInBackground(log);
    }
    return account;
  }

  /** The token of an account. An expired token is deleted here. */
  token(userId: string, log: (fields: Record<string, unknown>) => void): LinkedToken | undefined {
    const account = this.account(userId);
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
  dropToken(userId: string, token: string, log: (fields: Record<string, unknown>) => void): void {
    const account = this.account(userId);
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
    const key = input.userId;
    const keyHash = hashKey(input.deviceKey);
    const now = new Date().toISOString();

    let account = this.data.accounts[key];
    const existing = account?.devices.find((device) => sameHash(device.keyHash, keyHash));
    if (!existing && (account?.devices.length ?? 0) >= MAX_DEVICES) {
      throw new TooManyDevicesError(`This account has ${MAX_DEVICES} linked devices. Unlink one first.`);
    }

    this.removeDeviceEverywhere(keyHash, key);
    // Read again: the clean-up above deletes an account with no device and no user, and this one can be that.
    account = this.data.accounts[key];
    if (!account) {
      account = { username: input.username, userId: input.userId, devices: [], users: [] };
      this.data.accounts[key] = account;
      // It is back, so its data must stay.
      const pending = this.dropped.indexOf(key);
      if (pending >= 0) this.dropped.splice(pending, 1);
    }
    account.username = input.username;

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

  /** Removes one device. An account with no devices and no users is deleted, with its token. */
  unlink(deviceKey: string): boolean {
    return this.removeDeviceEverywhere(hashKey(deviceKey));
  }

  // ---- Signed-in users ----

  /** True when the account of a device key has a signed-in user. Undefined when no account has that device. */
  connected(deviceKey: string): boolean | undefined {
    const keyHash = hashKey(deviceKey);
    const account = Object.values(this.data.accounts).find((candidate) => candidate.devices.some((device) => sameHash(device.keyHash, keyHash)));
    return account ? account.users.length > 0 : undefined;
  }

  /**
   * Makes a connect ticket for the account of a device key. The ticket is returned once, and
   * only its hash is kept. Undefined when no account has that device.
   */
  startConnect(deviceKey: string): { ticket: string; username: string } | undefined {
    const keyHash = hashKey(deviceKey);
    const account = Object.values(this.data.accounts).find((candidate) => candidate.devices.some((device) => sameHash(device.keyHash, keyHash)));
    if (!account) return undefined;
    const now = Date.now();
    for (const [hash, ticket] of this.tickets) if (ticket.expires <= now) this.tickets.delete(hash);
    while (this.tickets.size >= MAX_TICKETS) this.tickets.delete(this.tickets.keys().next().value!);
    const ticket = randomBytes(32).toString("base64url");
    this.tickets.set(hashKey(ticket), { keyHash, userId: account.userId, expires: now + TICKET_TTL_MS });
    return { ticket, username: account.username };
  }

  /** The account a ticket would link, while the ticket is valid and its device is still on that account. */
  peekConnect(ticket: string): Account | undefined {
    const stored = this.tickets.get(hashKey(ticket));
    if (!stored || stored.expires <= Date.now()) return undefined;
    const account = this.account(stored.userId);
    return account?.devices.some((device) => sameHash(device.keyHash, stored.keyHash)) ? account : undefined;
  }

  /**
   * Uses a ticket: links its account to the user and writes the file. The ticket ends here also
   * when the write fails, and the link is then taken back. A user has one account: an older
   * link of the user is removed.
   */
  confirmConnect(ticket: string, authUserId: string): Promise<Account | undefined> {
    // One at a time: a failed write takes its change back, and that must not undo a later confirm.
    const run = this.confirms.then(() => this.confirmOne(ticket, authUserId));
    this.confirms = run.then(() => undefined, () => undefined);
    return run;
  }

  private async confirmOne(ticket: string, authUserId: string): Promise<Account | undefined> {
    const account = this.peekConnect(ticket);
    this.tickets.delete(hashKey(ticket));
    if (!account) return undefined;
    const before = Object.values(this.data.accounts)
      .filter((candidate) => candidate.users.includes(authUserId))
      .map((candidate) => candidate.userId);
    for (const candidate of Object.values(this.data.accounts)) {
      if (candidate !== account) candidate.users = candidate.users.filter((id) => id !== authUserId);
    }
    if (!account.users.includes(authUserId)) account.users.push(authUserId);
    try {
      await this.save();
    } catch (error) {
      account.users = account.users.filter((id) => id !== authUserId);
      for (const id of before) {
        const old = this.account(id);
        if (old && !old.users.includes(authUserId)) old.users.push(authUserId);
      }
      throw error;
    }
    // Only after the write: an account that lost its last user and has no device goes.
    if (this.dropEmptyAccounts()) await this.save();
    return account;
  }

  /** Removes a signed-in user from its account. True when something changed. Save after it. */
  unbindUser(authUserId: string): boolean {
    let changed = false;
    for (const account of Object.values(this.data.accounts)) {
      if (!account.users.includes(authUserId)) continue;
      account.users = account.users.filter((id) => id !== authUserId);
      changed = true;
    }
    this.dropEmptyAccounts();
    return changed;
  }

  /** Deletes each account with no devices and no users, with its token. */
  private dropEmptyAccounts(): boolean {
    let dropped = false;
    for (const [key, account] of Object.entries(this.data.accounts)) {
      if (account.devices.length > 0 || account.users.length > 0) continue;
      delete this.data.accounts[key];
      for (const [hash, ticket] of this.tickets) if (ticket.userId === account.userId) this.tickets.delete(hash);
      dropped = true;
      this.dropped.push(account.userId);
    }
    return dropped;
  }

  private removeDeviceEverywhere(keyHash: string, exceptAccount?: string): boolean {
    let removed = false;
    for (const [key, account] of Object.entries(this.data.accounts)) {
      if (key === exceptAccount) continue;
      const before = account.devices.length;
      account.devices = account.devices.filter((device) => !sameHash(device.keyHash, keyHash));
      if (account.devices.length === before) continue;
      removed = true;
    }
    // A ticket of a removed or moved device ends with it (peekConnect also checks the device).
    for (const [hash, ticket] of this.tickets) if (sameHash(ticket.keyHash, keyHash) && ticket.userId !== exceptAccount) this.tickets.delete(hash);
    this.dropEmptyAccounts();
    return removed;
  }
}

/** Writes a file with mode 600: to a temporary file first, then a rename, so a crash never leaves half a file. */
export async function writeFileAtomic(file: string, data: string | Buffer): Promise<void> {
  const temporary = `${file}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(data);
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await rename(temporary, file);
  } catch (error) {
    await unlink(temporary).catch(() => undefined);
    throw error;
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
