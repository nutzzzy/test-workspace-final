import { randomUUID } from "crypto";
import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import type { BrowserContext } from "playwright-core";
import { decryptSecret, encryptSecret, resolveEncryptionKey } from "../../common/crypto.util";
import { PrismaService } from "../../prisma/prisma.service";

/**
 * Saved browser sessions (Playwright storageState: cookies and page storage)
 * a UI step can start from, so a replay does not have to sign in again.
 *
 * Stored in the existing settings table, one row per session, with the state
 * encrypted by the app's secrets key. Only a summary (names, domains, counts,
 * expiry) ever leaves this class; cookie and storage values never do, and are
 * never logged. Deleting a session deletes its row, state included.
 */

export type StorageState = Awaited<ReturnType<BrowserContext["storageState"]>>;

export type SessionStatus = "valid" | "expired" | "unknown";

export type SavedSessionSummary = {
  id: string;
  name: string;
  /** Main domain (most cookies), for display. */
  domain: string;
  domains: string[];
  cookies: number;
  /** Cookie names only (values are secret). */
  cookieNames: string[];
  /** Page storage entries (localStorage) saved with it. */
  storage: number;
  status: SessionStatus;
  /** Earliest expiry of its expiring cookies (ISO), when any expire. */
  expiresAt: string | null;
  createdAt: string;
  updatedAt: string;
};

type StoredSession = Omit<SavedSessionSummary, "status"> & { stateEnc: string };

const PREFIX = "ui.session.";
const MAX_SESSIONS = 100;
const MAX_STATE_BYTES = 2_000_000;

/** What a storageState holds, without its values. */
export function summarize(state: StorageState) {
  const counts = new Map<string, number>();
  for (const cookie of state.cookies) {
    const domain = cookie.domain.replace(/^\./, "");
    counts.set(domain, (counts.get(domain) ?? 0) + 1);
  }
  for (const origin of state.origins) {
    try {
      const host = new URL(origin.origin).hostname;
      if (!counts.has(host)) counts.set(host, 0);
    } catch {
      // not a URL origin
    }
  }
  const domains = [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([domain]) => domain);
  const expiring = state.cookies.map((cookie) => cookie.expires).filter((expires) => expires > 0);
  return {
    domain: domains[0] ?? "",
    domains,
    cookies: state.cookies.length,
    cookieNames: [...new Set(state.cookies.map((cookie) => cookie.name))].slice(0, 50),
    storage: state.origins.reduce((sum, origin) => sum + origin.localStorage.length, 0),
    expiresAt: expiring.length ? new Date(Math.min(...expiring) * 1000).toISOString() : null,
  };
}

/**
 * Expired: it had cookies and every one of them has expired, and no page
 * storage could stand in for them. Unknown: browser-session cookies (no
 * expiry) or storage only — only opening the app tells. Valid otherwise.
 */
export function sessionStatus(state: Pick<StorageState, "cookies" | "origins">, now = Date.now()): SessionStatus {
  const storage = state.origins.some((origin) => origin.localStorage.length > 0);
  if (state.cookies.length === 0) return storage ? "unknown" : "expired";
  const alive = state.cookies.filter((cookie) => cookie.expires <= 0 || cookie.expires * 1000 > now);
  if (alive.length === 0) return storage ? "unknown" : "expired";
  return alive.some((cookie) => cookie.expires <= 0) ? "unknown" : "valid";
}

/** Status from the summary alone (no decryption): expiry passed → expired. */
function statusOf(stored: Omit<StoredSession, "stateEnc">, now = Date.now()): SessionStatus {
  if (stored.cookies === 0) return stored.storage > 0 ? "unknown" : "expired";
  if (stored.expiresAt && Date.parse(stored.expiresAt) <= now) return stored.storage > 0 ? "unknown" : "expired";
  return stored.expiresAt ? "valid" : "unknown";
}

@Injectable()
export class UiSessionStore {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  private key() {
    return resolveEncryptionKey(this.config.get<string>("SECRETS_ENCRYPTION_KEY"));
  }

  private parse(value: string): StoredSession | null {
    try {
      const parsed = JSON.parse(value) as StoredSession;
      return parsed && typeof parsed.id === "string" && typeof parsed.stateEnc === "string" ? parsed : null;
    } catch {
      return null;
    }
  }

  private view({ stateEnc: _state, ...stored }: StoredSession): SavedSessionSummary {
    return { ...stored, status: statusOf(stored) };
  }

  async list(): Promise<SavedSessionSummary[]> {
    const rows = await this.prisma.systemSetting.findMany({ where: { key: { startsWith: PREFIX } }, orderBy: { updatedAt: "desc" } });
    return rows.map((row) => this.parse(row.value)).filter((item): item is StoredSession => Boolean(item)).map((item) => this.view(item));
  }

  async get(id: string): Promise<SavedSessionSummary> {
    return this.view(await this.row(id));
  }

  /**
   * Save a browser's state under a name. `cookiesOnly` leaves page storage out.
   * Passwords are never part of it: storageState holds cookies and storage, not typed fields.
   */
  async create(name: string, state: StorageState, options: { cookiesOnly?: boolean } = {}): Promise<SavedSessionSummary> {
    const clean = name.trim().slice(0, 120);
    if (!clean) throw new BadRequestException("Name the session");
    const kept: StorageState = options.cookiesOnly ? { cookies: state.cookies, origins: [] } : state;
    if (kept.cookies.length === 0 && kept.origins.every((origin) => origin.localStorage.length === 0)) {
      throw new BadRequestException("The browser has no cookies or storage to save yet; sign in first");
    }
    const plain = JSON.stringify(kept);
    if (plain.length > MAX_STATE_BYTES) throw new BadRequestException("The session is too large to save");
    if ((await this.prisma.systemSetting.count({ where: { key: { startsWith: PREFIX } } })) >= MAX_SESSIONS) {
      throw new BadRequestException("Too many saved sessions; delete some first");
    }
    const now = new Date().toISOString();
    const stored: StoredSession = { id: randomUUID(), name: clean, ...summarize(kept), createdAt: now, updatedAt: now, stateEnc: encryptSecret(plain, this.key()) };
    await this.prisma.systemSetting.create({ data: { key: `${PREFIX}${stored.id}`, value: JSON.stringify(stored) } });
    return this.view(stored);
  }

  /** Replace a saved session's state (sign in again, then save over it); the name stays. */
  async replace(id: string, state: StorageState, options: { cookiesOnly?: boolean } = {}): Promise<SavedSessionSummary> {
    const current = await this.row(id);
    const kept: StorageState = options.cookiesOnly ? { cookies: state.cookies, origins: [] } : state;
    const next: StoredSession = { ...current, ...summarize(kept), updatedAt: new Date().toISOString(), stateEnc: encryptSecret(JSON.stringify(kept), this.key()) };
    await this.prisma.systemSetting.update({ where: { key: `${PREFIX}${id}` }, data: { value: JSON.stringify(next) } });
    return this.view(next);
  }

  async rename(id: string, name: string): Promise<SavedSessionSummary> {
    const clean = name.trim().slice(0, 120);
    if (!clean) throw new BadRequestException("Name the session");
    const next = { ...(await this.row(id)), name: clean, updatedAt: new Date().toISOString() };
    await this.prisma.systemSetting.update({ where: { key: `${PREFIX}${id}` }, data: { value: JSON.stringify(next) } });
    return this.view(next);
  }

  /** Deletes the profile and its stored cookies and storage. */
  async remove(id: string) {
    await this.prisma.systemSetting.delete({ where: { key: `${PREFIX}${id}` } }).catch(() => {
      throw new NotFoundException("Saved session not found");
    });
    return { ok: true };
  }

  /** The decrypted state, for a replay or recording browser only (never sent to a client). */
  async state(id: string): Promise<StorageState | null> {
    const row = await this.prisma.systemSetting.findUnique({ where: { key: `${PREFIX}${id}` } });
    const stored = row ? this.parse(row.value) : null;
    if (!stored) return null;
    try {
      return JSON.parse(decryptSecret(stored.stateEnc, this.key())) as StorageState;
    } catch {
      return null;
    }
  }

  private async row(id: string): Promise<StoredSession> {
    const row = await this.prisma.systemSetting.findUnique({ where: { key: `${PREFIX}${id}` } });
    const stored = row ? this.parse(row.value) : null;
    if (!stored) throw new NotFoundException("Saved session not found");
    return stored;
  }
}
