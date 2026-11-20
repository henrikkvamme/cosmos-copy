// Pick sessions, variant boards and the pick history.
//
//   DATA_DIR/picks.json               sessions and boards, keyed by the SHA-256 hash of their id
//   DATA_DIR/boards/<hash>/<n>.webp   the screenshots of a board
//   DATA_DIR/history/<owner>.json  the pick history of one user, newest task first
//   DATA_DIR/history-images/<owner>/  the final screenshots of the style records
//
// The owner is the Cosmos user id of the linked account. Older data used the username: load()
// moves it.
//
// A session id or board id is a bearer secret, like a device key: 32 random bytes in base64url.
// The store keeps only its hash. Never log an id.

import { createHash, randomBytes } from "node:crypto";
import { mkdir, readdir, readFile, rename, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { writeFileAtomic } from "./store.js";

export const ID_PATTERN = /^[A-Za-z0-9_-]{43}$/;
export const MAX_CANDIDATES = 60;
export const MORE_PER_ROUND = 12;
export const MAX_MORE_ROUNDS = 5;
export const MAX_VARIANTS = 6;
const SESSION_TTL_MS = 7 * 24 * 60 * 60_000;
const BOARD_TTL_MS = 30 * 24 * 60 * 60_000;
const MAX_SESSIONS_PER_USER = 20;
const MAX_BOARDS_PER_USER = 30;
const MAX_HISTORY_TASKS = 100;
const HISTORY_TTL_MS = 365 * 24 * 60 * 60_000;
const MAX_PASSED_PER_TASK = 300;
const MAX_PICKED_PER_TASK = 100;
/** A note about a task changes the newest entry of that task when it is younger than this. */
const NOTE_MERGE_MS = 7 * 24 * 60 * 60_000;
/** A result image that no entry names is deleted when it is older than this. A new image waits this long for its entry. */
const ORPHAN_IMAGE_MS = Number(process.env.ORPHAN_IMAGE_MS ?? 10 * 60_000); // The variable is for tests.
const RESULT_FILE_PATTERN = /^[A-Za-z0-9_-]{43}\.jpg$/;

type Log = (fields: Record<string, unknown>) => void;

export interface Tile {
  id: string;
  /** The still image on cdn.cosmos.so. */
  thumb: string;
  w?: number;
  h?: number;
  kind: "image" | "video";
  /** 0 for the agent's candidates, 1 and up for each "More like these". */
  round: number;
}

export interface Session {
  owner: string;
  task: string;
  createdAt: string;
  updatedAt: string;
  status: "open" | "done";
  tiles: Tile[];
  /** Ids in the order the user picked them. */
  picked: string[];
  /** Ids whose image did not load in the picker. They do not count as passed. */
  hidden: string[];
  rounds: number;
  doneAt?: string;
  /** The last time the picker page read the session. */
  seenAt?: string;
}

export interface BoardRef {
  id: string;
  thumb: string;
  w?: number;
  h?: number;
  what?: string;
}

export interface Variant {
  name: string;
  takes: BoardRef[];
  image?: { w: number; h: number; version: number };
}

export interface Board {
  owner: string;
  task: string;
  createdAt: string;
  uploadHash: string;
  variants: Variant[];
}

export interface HistoryItem {
  id: string;
  thumb: string;
}

/**
 * The style record of a task: the design the user accepted. It holds its own copy of the
 * references, so later changes to picked and passed do not change it.
 */
export interface HistoryResult {
  at: string;
  /** The hash of the canvas (board) it came from. A new record for the same canvas replaces this one. */
  board: string;
  /** The name of the accepted variant. */
  variant: string;
  took: { id: string; thumb: string; what: string }[];
  deviations: string;
  /** The file of the final screenshot in history-images/<owner>/. */
  file: string;
  image: { w: number; h: number };
}

export interface HistoryEntry {
  task: string;
  at: string;
  picked: HistoryItem[];
  passed: HistoryItem[];
  /** The app or repository the design was made for. */
  project?: string;
  result?: HistoryResult;
}

interface PicksFile {
  version: 1;
  sessions: Record<string, Session>;
  boards: Record<string, Board>;
}

interface HistoryFile {
  version: 1;
  entries: HistoryEntry[];
}

export function newId(): string {
  return randomBytes(32).toString("base64url");
}

export function hashId(id: string): string {
  return createHash("sha256").update(id, "utf8").digest("hex");
}

/** Serializes writes of one file and folds changes that arrive during a write into one more write. */
class Writer {
  private running?: Promise<void>;
  private dirty = false;

  constructor(private readonly write: () => Promise<void>) {}

  save(): Promise<void> {
    this.dirty = true;
    this.running ??= this.flush();
    return this.running;
  }

  private async flush(): Promise<void> {
    try {
      while (this.dirty) {
        this.dirty = false;
        await this.write();
      }
    } finally {
      this.running = undefined;
    }
  }
}

export class PickStore {
  private data: PicksFile = { version: 1, sessions: {}, boards: {} };
  private readonly file: string;
  private readonly writer: Writer;
  private readonly histories = new Map<string, HistoryFile>();
  private readonly historyWriters = new Map<string, Writer>();
  /** Per user: the result images that the history file on disk names, as of the last write. */
  private readonly savedImages = new Map<string, Set<string>>();
  private readonly waiters = new Map<string, Set<() => void>>();

  constructor(readonly dir: string) {
    this.file = join(dir, "picks.json");
    this.writer = new Writer(() => writeFileAtomic(this.file, JSON.stringify(this.data) + "\n"));
  }

  /** `legacyOwners`: username in lower case to Cosmos user id, for data that was stored under the username. */
  async load(log: Log, legacyOwners: Map<string, string> = new Map()): Promise<void> {
    await this.moveLegacyFiles(log, legacyOwners);
    let text: string;
    try {
      text = await readFile(this.file, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") log({ level: "error", event: "picks_unreadable", error: (error as Error).message });
      return;
    }
    try {
      const parsed = JSON.parse(text) as PicksFile;
      if (parsed?.version !== 1 || typeof parsed.sessions !== "object" || typeof parsed.boards !== "object") throw new Error("unknown format");
      let moved = 0;
      for (const group of [parsed.sessions, parsed.boards] as Record<string, { owner?: string; username?: string }>[]) {
        for (const [hash, item] of Object.entries(group)) {
          if (typeof item.owner === "string") continue;
          const owner = legacyOwners.get(String(item.username ?? "").toLowerCase());
          // Without a linked account nobody can reach the item.
          if (!owner) delete group[hash];
          else {
            item.owner = owner;
            delete item.username;
          }
          moved++;
        }
      }
      this.data = parsed;
      if (moved) await this.save().catch((error: unknown) => log({ level: "error", event: "picks_write_failed", error: (error as Error).message }));
      log({ event: "picks_loaded", sessions: Object.keys(parsed.sessions).length, boards: Object.keys(parsed.boards).length });
    } catch (error) {
      const aside = `${this.file}.broken-${Date.now()}`;
      log({ level: "error", event: "picks_broken", movedTo: aside, error: (error as Error).message });
      await rename(this.file, aside).catch(() => undefined);
    }
    await this.prune(log);
  }

  save(): Promise<void> {
    return this.writer.save();
  }

  /** Moves the history and the result images of a username to the Cosmos user id. An existing target stays. */
  private async moveLegacyFiles(log: Log, legacyOwners: Map<string, string>): Promise<void> {
    for (const [name, owner] of legacyOwners) {
      const moves: [string, string][] = [
        [this.historyFile(name), this.historyFile(owner)],
        [this.resultDir(name), this.resultDir(owner)],
      ];
      for (const [from, to] of moves) {
        if (from === to) continue;
        const exists = (path: string) => stat(path).then(() => true, () => false);
        if (!(await exists(from)) || (await exists(to))) continue;
        await rename(from, to).then(
          () => log({ event: "picks_owner_moved" }),
          (error: unknown) => log({ level: "error", event: "picks_owner_move_failed", error: (error as Error).message }),
        );
      }
    }
  }

  /** Deletes all data of an owner: sessions, boards with their screenshots, the history and its images. */
  async deleteOwner(owner: string, log: Log): Promise<void> {
    const key = owner.toLowerCase();
    for (const [hash, session] of Object.entries(this.data.sessions)) {
      if (session.owner.toLowerCase() !== key) continue;
      delete this.data.sessions[hash];
      for (const finish of [...(this.waiters.get(hash) ?? [])]) finish();
    }
    for (const [hash, board] of Object.entries(this.data.boards)) {
      if (board.owner.toLowerCase() === key) await this.deleteBoard(hash);
    }
    const file = this.histories.get(key);
    if (file) file.entries.splice(0, file.entries.length);
    this.histories.delete(key);
    this.historyWriters.delete(key);
    this.savedImages.delete(key);
    await rm(this.historyFile(key), { force: true }).catch(() => undefined);
    await rm(this.resultDir(key), { recursive: true, force: true }).catch(() => undefined);
    await this.save().catch((error: unknown) => log({ level: "error", event: "picks_write_failed", error: (error as Error).message }));
    log({ event: "owner_deleted" });
  }

  /** Deletes expired sessions and boards. */
  async prune(log: Log): Promise<void> {
    const now = Date.now();
    let changed = false;
    for (const [hash, session] of Object.entries(this.data.sessions)) {
      if (now - Date.parse(session.updatedAt) > SESSION_TTL_MS) {
        delete this.data.sessions[hash];
        changed = true;
      }
    }
    for (const [hash, board] of Object.entries(this.data.boards)) {
      if (now - Date.parse(board.createdAt) > BOARD_TTL_MS) {
        await this.deleteBoard(hash);
        changed = true;
      }
    }
    if (changed) {
      await this.save().catch((error: unknown) => log({ level: "error", event: "picks_write_failed", error: (error as Error).message }));
    }
  }

  // ---- Sessions ----

  createSession(owner: string, task: string, tiles: Tile[]): { id: string; session: Session } {
    const mine = Object.entries(this.data.sessions)
      .filter(([, s]) => s.owner.toLowerCase() === owner.toLowerCase())
      .sort(([, a], [, b]) => a.updatedAt.localeCompare(b.updatedAt));
    while (mine.length >= MAX_SESSIONS_PER_USER) delete this.data.sessions[mine.shift()![0]];
    const id = newId();
    const now = new Date().toISOString();
    const session: Session = { owner, task, createdAt: now, updatedAt: now, status: "open", tiles, picked: [], hidden: [], rounds: 0 };
    this.data.sessions[hashId(id)] = session;
    return { id, session };
  }

  /** The session of an id. An expired session counts as missing. */
  session(id: string): Session | undefined {
    if (!ID_PATTERN.test(id)) return undefined;
    const session = this.data.sessions[hashId(id)];
    if (!session || Date.now() - Date.parse(session.updatedAt) > SESSION_TTL_MS) return undefined;
    return session;
  }

  /** The newest sessions of a user, newest first. */
  sessionsOf(owner: string): Session[] {
    return Object.values(this.data.sessions)
      .filter((s) => s.owner.toLowerCase() === owner.toLowerCase())
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  touch(session: Session): void {
    session.updatedAt = new Date().toISOString();
  }

  /** Waits until the session is done, for at most `ms`. Resolves true when it is done. */
  waitDone(id: string, ms: number, signal?: AbortSignal): Promise<boolean> {
    if (this.session(id)?.status === "done") return Promise.resolve(true);
    const hash = hashId(id);
    return new Promise((resolve) => {
      let set = this.waiters.get(hash);
      if (!set) this.waiters.set(hash, (set = new Set()));
      const finish = () => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", finish);
        set!.delete(finish);
        if (set!.size === 0) this.waiters.delete(hash);
        resolve(this.session(id)?.status === "done");
      };
      const timer = setTimeout(finish, ms);
      set.add(finish);
      signal?.addEventListener("abort", finish, { once: true });
    });
  }

  /** Wakes the calls that wait for this session. */
  wake(id: string): void {
    for (const finish of [...(this.waiters.get(hashId(id)) ?? [])]) finish();
  }

  // ---- Boards ----

  createBoard(owner: string, task: string, variants: Variant[]): { id: string; uploadId: string; board: Board } {
    const mine = Object.entries(this.data.boards)
      .filter(([, b]) => b.owner.toLowerCase() === owner.toLowerCase())
      .sort(([, a], [, b]) => a.createdAt.localeCompare(b.createdAt));
    while (mine.length >= MAX_BOARDS_PER_USER) void this.deleteBoard(mine.shift()![0]);
    const id = newId();
    const uploadId = newId();
    const board: Board = { owner, task, createdAt: new Date().toISOString(), uploadHash: hashId(uploadId), variants };
    this.data.boards[hashId(id)] = board;
    return { id, uploadId, board };
  }

  board(id: string): Board | undefined {
    if (!ID_PATTERN.test(id)) return undefined;
    return this.liveBoard(hashId(id));
  }

  /** The board of a view id, with its hash (the name of its image folder). */
  boardWithHash(id: string): { hash: string; board: Board } | undefined {
    const board = this.board(id);
    return board ? { hash: hashId(id), board } : undefined;
  }

  /** The board of an upload id, with its hash (the name of its image folder). */
  boardForUpload(uploadId: string): { hash: string; board: Board } | undefined {
    if (!ID_PATTERN.test(uploadId)) return undefined;
    const uploadHash = hashId(uploadId);
    for (const [hash, board] of Object.entries(this.data.boards)) {
      if (board.uploadHash === uploadHash && this.liveBoard(hash)) return { hash, board };
    }
    return undefined;
  }

  imageFile(boardHash: string, index: number): string {
    return join(this.dir, "boards", boardHash, `${index + 1}.webp`);
  }

  async writeImage(boardHash: string, index: number, data: Buffer): Promise<void> {
    await mkdir(join(this.dir, "boards", boardHash), { recursive: true, mode: 0o700 });
    await writeFileAtomic(this.imageFile(boardHash, index), data);
  }

  private liveBoard(hash: string): Board | undefined {
    const board = this.data.boards[hash];
    if (!board || Date.now() - Date.parse(board.createdAt) > BOARD_TTL_MS) return undefined;
    return board;
  }

  private async deleteBoard(hash: string): Promise<void> {
    delete this.data.boards[hash];
    if (!/^[0-9a-f]{64}$/.test(hash)) return;
    await rm(join(this.dir, "boards", hash), { recursive: true, force: true }).catch(() => undefined);
  }

  // ---- History ----

  private historyFile(owner: string): string {
    return join(this.dir, "history", `${owner.toLowerCase()}.json`);
  }

  /**
   * The history of one user, loaded once. The file object stays the same for each user, and
   * callers change its entries in one synchronous step after this returns, so two changes at
   * the same time cannot lose each other.
   */
  private async historyOf(owner: string): Promise<HistoryFile> {
    const key = owner.toLowerCase();
    let file = this.histories.get(key);
    if (!file) {
      let loaded: HistoryFile;
      try {
        const parsed = JSON.parse(await readFile(this.historyFile(key), "utf8")) as HistoryFile;
        loaded = parsed?.version === 1 && Array.isArray(parsed.entries) ? parsed : { version: 1, entries: [] };
      } catch {
        loaded = { version: 1, entries: [] };
      }
      // Another call may have loaded it while this one waited.
      file = this.histories.get(key) ?? loaded;
      this.histories.set(key, file);
    }
    const cutoff = Date.now() - HISTORY_TTL_MS;
    const kept = file.entries.filter((entry) => Date.parse(entry.at) >= cutoff).slice(0, MAX_HISTORY_TASKS);
    file.entries.splice(0, file.entries.length, ...kept);
    return file;
  }

  /** A copy of the history, newest first. */
  async history(owner: string): Promise<HistoryEntry[]> {
    return [...(await this.historyOf(owner)).entries];
  }

  async addHistory(owner: string, entry: HistoryEntry): Promise<void> {
    const file = await this.historyOf(owner);
    file.entries.unshift({ ...entry, passed: entry.passed.slice(0, MAX_PASSED_PER_TASK) });
    if (file.entries.length > MAX_HISTORY_TASKS) file.entries.length = MAX_HISTORY_TASKS;
    await this.saveHistory(owner);
  }

  /**
   * Records what an agent reports outside a pick session: references the user pasted (picks) and
   * references they reject (passed). It changes the newest entry of the task (by name, case does
   * not matter) when that entry is younger than a week, else it adds an entry. A rejected
   * reference moves from picked to passed.
   */
  async noteReferences(owner: string, task: string, pasted: HistoryItem[], rejected: HistoryItem[]): Promise<{ picked: number; passed: number }> {
    const file = await this.historyOf(owner);
    const wanted = task.trim().toLowerCase();
    const cutoff = Date.now() - NOTE_MERGE_MS;
    let entry = file.entries.find((e) => e.task.trim().toLowerCase() === wanted && Date.parse(e.at) >= cutoff);
    if (!entry) {
      entry = { task: task.trim(), at: new Date().toISOString(), picked: [], passed: [] };
      file.entries.unshift(entry);
      if (file.entries.length > MAX_HISTORY_TASKS) file.entries.length = MAX_HISTORY_TASKS;
    }
    const rejectedIds = new Set(rejected.map((item) => item.id));
    for (const item of pasted) {
      if (rejectedIds.has(item.id)) continue;
      if (!entry.picked.some((p) => p.id === item.id)) entry.picked.push(item);
      entry.passed = entry.passed.filter((p) => p.id !== item.id);
    }
    // At the limit the oldest picks go, so a new paste is always stored.
    entry.picked = entry.picked.filter((p) => !rejectedIds.has(p.id)).slice(-MAX_PICKED_PER_TASK);
    // Rejected references go first, so the history sheet shows them before the other passes.
    entry.passed = [...rejected, ...entry.passed.filter((p) => !rejectedIds.has(p.id))].slice(0, MAX_PASSED_PER_TASK);
    await this.saveHistory(owner);
    return { picked: entry.picked.length, passed: entry.passed.length };
  }

  // ---- Style records ----

  private resultDir(owner: string): string {
    return join(this.dir, "history-images", owner.toLowerCase().replace(/[^a-z0-9_.-]/g, "_"));
  }

  /** Stores a final screenshot and returns its file name. Call noteResult with it at once. */
  async writeResultImage(owner: string, data: Buffer): Promise<string> {
    const file = `${newId()}.jpg`;
    await mkdir(this.resultDir(owner), { recursive: true, mode: 0o700 });
    await writeFileAtomic(join(this.resultDir(owner), file), data);
    return file;
  }

  async readResultImage(owner: string, file: string): Promise<Buffer | undefined> {
    if (!RESULT_FILE_PATTERN.test(file)) return undefined;
    return readFile(join(this.resultDir(owner), file)).catch(() => undefined);
  }

  /**
   * Records the accepted design of a task. The image file must exist already. The entry is, in
   * this order: the one that holds a record of the same canvas (replaced), the newest entry of
   * the task without a record and younger than a week, or a new entry. A record of another
   * canvas is never replaced, so two projects with the same task name keep their own records.
   */
  async noteResult(owner: string, task: string, project: string, result: HistoryResult): Promise<{ replaced: boolean }> {
    const file = await this.historyOf(owner);
    const wanted = task.trim().toLowerCase();
    const cutoff = Date.now() - NOTE_MERGE_MS;
    let entry = file.entries.find((e) => e.result?.board === result.board);
    const replaced = entry !== undefined;
    entry ??= file.entries.find((e) => !e.result && e.task.trim().toLowerCase() === wanted && Date.parse(e.at) >= cutoff);
    if (!entry) {
      entry = { task: task.trim(), at: new Date().toISOString(), picked: result.took.map(({ id, thumb }) => ({ id, thumb })), passed: [] };
      file.entries.unshift(entry);
      if (file.entries.length > MAX_HISTORY_TASKS) file.entries.length = MAX_HISTORY_TASKS;
    }
    entry.project = project;
    entry.result = result;
    await this.saveHistory(owner);
    return { replaced };
  }

  /**
   * Deletes the result images that no entry names. It runs after each save, when the file on
   * disk and the entries in memory are the same. This one step covers a cleared task, an expired
   * entry, an entry over the limit, a replaced record and a write that was interrupted.
   */
  private async dropUnusedImages(owner: string): Promise<void> {
    const dir = this.resultDir(owner);
    const names = await readdir(dir).catch(() => [] as string[]);
    if (names.length === 0) return;
    const key = owner.toLowerCase();
    // A file stays while the entries in memory or the last file on disk name it. They differ when
    // a save failed or is still to come, and then the file on disk can still need the old image.
    const named = (name: string) =>
      (this.histories.get(key)?.entries ?? []).some((entry) => entry.result?.file === name) || (this.savedImages.get(key)?.has(name) ?? true);
    for (const name of names) {
      if (named(name)) continue;
      const age = await stat(join(dir, name)).then((s) => Date.now() - s.mtimeMs, () => 0);
      // The check runs again after the wait, and the delete starts in the same step.
      if (age > ORPHAN_IMAGE_MS && !named(name)) await rm(join(dir, name), { force: true }).catch(() => undefined);
    }
  }

  /** Deletes the entries of one task (by name, case does not matter), or all. Returns the number deleted. */
  async clearHistory(owner: string, task?: string): Promise<number> {
    const file = await this.historyOf(owner);
    const before = file.entries.length;
    const wanted = task?.trim().toLowerCase();
    const kept = wanted ? file.entries.filter((entry) => entry.task.trim().toLowerCase() !== wanted) : [];
    file.entries.splice(0, file.entries.length, ...kept);
    await this.saveHistory(owner);
    return before - kept.length;
  }

  private async saveHistory(owner: string): Promise<void> {
    const key = owner.toLowerCase();
    let writer = this.historyWriters.get(key);
    if (!writer) {
      writer = new Writer(async () => {
        await mkdir(join(this.dir, "history"), { recursive: true, mode: 0o700 });
        const file = this.histories.get(key) ?? { version: 1, entries: [] };
        // The text and the list of images come from the same state, in one step.
        const text = JSON.stringify(file) + "\n";
        const images = new Set(file.entries.flatMap((entry) => (entry.result ? [entry.result.file] : [])));
        await writeFileAtomic(this.historyFile(key), text);
        this.savedImages.set(key, images);
      });
      this.historyWriters.set(key, writer);
    }
    await writer.save();
    await this.dropUnusedImages(owner);
  }
}
