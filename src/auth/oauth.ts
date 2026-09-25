import { discoverOAuthServerInfo, refreshAuthorization } from "@modelcontextprotocol/sdk/client/auth.js";
import type { OAuthClientInformationFull, OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js";
import { neverSent } from "../client/classify.js";
import { LoginRequired, RefreshUnavailable, TokenSaveFailed } from "../errors.js";
import type { AuthHandle, LumberroomConfig } from "../types.js";
import { FENCE_TIMEOUT_MS, withFence, type FenceHandle } from "./fence.js";
import { TokenStore, tokenPaths, type StoredDiscovery, type StoredOAuth } from "./store.js";

export const REFRESH_SKEW_MS = 60_000;
const REFRESH_TIMEOUT_MS = 30_000;
const RUN_LOGIN = "Run: openclaw lumberroom login";

export type OAuthStatus = "signed_in" | "signed_out" | "expired_no_refresh" | "refused";

export interface OAuthAuthOptions {
  stateDir: string;
  fetch?: typeof globalThis.fetch;
  now?: () => number;
  fenceTimeoutMs?: number;
  refreshTimeoutMs?: number;
}

type Fetch = (url: string | URL, init?: RequestInit) => Promise<Response>;

/** A rotated pair the disk refused. Its refresh token is the only live one, and only this process holds it. */
interface Unsaved {
  tokens: OAuthTokens;
  expiresAt: number | null;
  clientInformation: OAuthClientInformationFull | null;
  discovery: StoredDiscovery;
  resource: string | null;
  marker: bigint; // the file version once the spent token came off disk; 0n when the file went with it
}

class FenceLost extends Error {
  constructor() {
    super("another process took the refresh lock before the grant went out");
    this.name = "FenceLost";
  }
}

function reason(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function errnoOf(e: unknown): string | undefined {
  const code = (e as NodeJS.ErrnoException | null)?.code;
  return typeof code === "string" ? code : undefined;
}

/** The job's outcome, or the deadline's reason. The job itself never sees the deadline. */
function race<T>(job: Promise<T>, deadline: AbortSignal): Promise<T> {
  if (deadline.aborted) return Promise.reject(deadline.reason);
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(deadline.reason);
    deadline.addEventListener("abort", onAbort, { once: true });
    job.then(
      (v) => {
        deadline.removeEventListener("abort", onAbort);
        resolve(v);
      },
      (e: unknown) => {
        deadline.removeEventListener("abort", onAbort);
        reject(e);
      },
    );
  });
}

function within(job: Promise<unknown>, ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    const done = () => {
      clearTimeout(timer);
      resolve();
    };
    job.then(done, done);
  });
}

/**
 * The guard and the fenced refresh of spec 7.2. One job at a time per process runs a grant or a
 * save, and it belongs to this handle, never to a caller: a caller that gives up stops waiting while
 * the job holds the fence until the rotated pair is on disk. The engine revokes the whole family
 * when a spent refresh token comes back (ENG/src/authserver/routes.rs:779-790).
 */
class OAuthAuth implements AuthHandle {
  readonly mode = "oauth" as const;
  private readonly store: TokenStore;
  private readonly lock: string;
  private readonly now: () => number;
  private readonly fetch: Fetch;
  private readonly fenceTimeoutMs: number;
  private readonly refreshTimeoutMs: number;
  private stored: StoredOAuth;
  private seen = -1n;
  private job: Promise<void> | null = null;
  private unsaved: Unsaved | null = null;
  private refusedAt: bigint | null = null; // the file version whose refresh the server refused
  private rejectedAccess: string | null = null; // an access token the engine answered 401 to
  private renewedAfter401: string | null = null; // the access token a 401-forced refresh produced

  constructor(private readonly cfg: LumberroomConfig, opts: OAuthAuthOptions) {
    const paths = tokenPaths(opts.stateDir);
    this.lock = paths.lock;
    this.store = new TokenStore(paths.file, cfg.mcpUrl, { now: opts.now });
    this.now = opts.now ?? Date.now;
    // Looked up per call, so a fetch swapped in after construction still applies.
    this.fetch = opts.fetch ?? ((url, init) => globalThis.fetch(url, init));
    this.fenceTimeoutMs = opts.fenceTimeoutMs ?? FENCE_TIMEOUT_MS;
    this.refreshTimeoutMs = opts.refreshTimeoutMs ?? REFRESH_TIMEOUT_MS;
    this.stored = this.store.read();
  }

  async authorize(deadline: AbortSignal): Promise<string> {
    deadline.throwIfAborted();
    // No await between reading this.job and setting it, so every caller in this process joins one job.
    const job = this.job ?? this.start();
    if (!job) return this.bearer();
    try {
      await race(job, deadline);
    } catch (e) {
      // Inside the skew window the access token still works, so a refresh that failed without
      // spending anything need not fail the call.
      if (e instanceof RefreshUnavailable && this.live()) return `Bearer ${this.stored.tokens!.access_token}`;
      throw e;
    }
    return this.afterJob();
  }

  rejected(authorization: string): void {
    const access = this.stored.tokens?.access_token;
    // A late 401 for a header this process already replaced says nothing about the current pair.
    if (!access || authorization !== `Bearer ${access}`) return;
    if (access === this.renewedAfter401) {
      this.refusedAt = this.seen;
      return;
    }
    this.rejectedAccess = access;
  }

  async settle(timeoutMs: number): Promise<void> {
    const until = Date.now() + timeoutMs;
    if (this.job) await within(this.job, timeoutMs);
    // A pair the disk refused lives only here. One more save before the process goes; a failure
    // leaves no refresh token on disk, so the next process asks for a sign-in instead of replaying.
    if (this.unsaved && !this.job) await within(this.launch(this.saveFenced()), until - Date.now());
  }

  status(): OAuthStatus {
    this.reloadIfChanged();
    const t = this.stored.tokens;
    if (this.unsaved) return "signed_in";
    if (!t) return "signed_out";
    if (this.refusedAt === this.seen) return "refused";
    if (!t.refresh_token && (this.expired() || t.access_token === this.rejectedAccess)) return "expired_no_refresh";
    return "signed_in";
  }

  /** The job this call needs, or null when the stored pair will do. Throws LoginRequired. */
  private start(): Promise<void> | null {
    if (this.unsaved) return this.launch(this.saveFenced());
    this.reloadIfChanged();
    const t = this.stored.tokens;
    if (!t) throw new LoginRequired();
    if (this.refusedAt === this.seen) throw new LoginRequired(`lumberroom refused the stored sign-in. ${RUN_LOGIN}`);
    if (t.refresh_token && this.due()) return this.launch(this.refreshFenced(t.refresh_token));
    return null;
  }

  private launch(work: Promise<void>): Promise<void> {
    const job: Promise<void> = work.finally(() => {
      if (this.job === job) this.job = null;
    });
    // Every caller may have stopped waiting; the outcome still lands on disk and in this handle.
    job.catch(() => undefined);
    this.job = job;
    return job;
  }

  private bearer(): string {
    const t = this.stored.tokens!;
    if (this.expired() || t.access_token === this.rejectedAccess) {
      throw new LoginRequired(`the lumberroom sign-in expired and cannot renew. ${RUN_LOGIN}`);
    }
    return `Bearer ${t.access_token}`;
  }

  // A job that succeeded leaves the freshest pair the server issued on disk. It goes out even when
  // an access lifetime under the skew makes it due again, so one call never runs two grants.
  private afterJob(): string {
    this.reloadIfChanged();
    const t = this.stored.tokens;
    if (!t) throw new LoginRequired();
    if (this.refusedAt === this.seen) throw new LoginRequired(`lumberroom refused the stored sign-in. ${RUN_LOGIN}`);
    if (t.access_token === this.rejectedAccess || (!t.refresh_token && this.expired())) {
      throw new LoginRequired(`the lumberroom sign-in expired and cannot renew. ${RUN_LOGIN}`);
    }
    return `Bearer ${t.access_token}`;
  }

  private expired(): boolean {
    const at = this.stored.expiresAt;
    return at !== null && at <= this.now();
  }

  private live(): boolean {
    const t = this.stored.tokens;
    return !!t && !this.expired() && t.access_token !== this.rejectedAccess;
  }

  private due(): boolean {
    const at = this.stored.expiresAt;
    return at === null || at - this.now() < REFRESH_SKEW_MS || this.stored.tokens?.access_token === this.rejectedAccess;
  }

  private reloadIfChanged(): void {
    if (this.store.version() !== this.seen) this.reload();
  }

  private reload(): void {
    // Version first: a write that lands between the two reads shows up as a change next time.
    this.seen = this.store.version();
    this.stored = this.store.read();
  }

  private async refreshFenced(wanted: string): Promise<void> {
    const forced = this.rejectedAccess !== null && this.rejectedAccess === this.stored.tokens?.access_token;
    await withFence(
      this.lock,
      async (fence) => {
        this.reload();
        const s = this.stored;
        // A peer refreshed, signed in again or signed out while this process waited. Its pair is newer
        // than anything this process could fetch, and `wanted` may already be spent.
        if (s.tokens?.refresh_token !== wanted) return;
        if (s.refreshStartedAt !== null) {
          // A holder died between sending a grant and saving the answer, so `wanted` may be spent.
          // Presenting it risks the family; the engine would revoke it on the replay anyway.
          this.forgetRefreshToken();
          throw new LoginRequired(`a lumberroom token refresh in another process never finished, so the stored sign-in cannot be trusted. ${RUN_LOGIN}`);
        }
        if (!s.clientInformation) {
          this.refusedAt = this.seen;
          throw new LoginRequired(`the stored lumberroom sign-in has no client registration. ${RUN_LOGIN}`);
        }
        let discovery = s.discovery;
        const discovered = !discovery;
        if (!discovery) {
          try {
            discovery = await discoverOAuthServerInfo(this.cfg.mcpUrl, {
              fetchFn: (url, init) => this.fetch(url, { ...init, signal: AbortSignal.timeout(this.refreshTimeoutMs) }),
            });
          } catch (e) {
            throw new RefreshUnavailable(`lumberroom could not find its authorization server: ${reason(e)}`);
          }
        }
        if (fence.compromised()) throw new RefreshUnavailable(new FenceLost().message);
        try {
          this.store.write({ refreshStartedAt: this.now(), ...(discovered ? { discovery } : {}) });
        } catch (e) {
          throw new RefreshUnavailable(`lumberroom could not mark the refresh in its token file (${errnoOf(e) ?? reason(e)})`);
        }

        const grant = { sent: false, status: null as number | null };
        // The refresh's own bound. A caller's deadline never reaches it: cancelled after the engine
        // rotated, it would strand the only live refresh token.
        const signal = AbortSignal.timeout(this.refreshTimeoutMs);
        const fetchFn: Fetch = async (url, init) => {
          if (fence.compromised()) throw new FenceLost();
          grant.sent = true;
          try {
            const res = await this.fetch(url, { ...init, signal });
            grant.status = res.status;
            return res;
          } catch (e) {
            if (grant.status === null && neverSent(e)) grant.sent = false;
            throw e;
          }
        };

        let tokens: OAuthTokens;
        try {
          tokens = await refreshAuthorization(discovery.authorizationServerUrl, {
            metadata: discovery.authorizationServerMetadata,
            clientInformation: s.clientInformation,
            refreshToken: wanted,
            // The value sign-in used: the engine settles the resource before it spends the token.
            resource: s.resource ?? undefined,
            fetchFn,
          });
        } catch (e) {
          this.refreshFailed(e, grant, fence);
        }

        const receivedAt = this.now();
        try {
          this.store.saveTokens(tokens, receivedAt);
        } catch (e) {
          this.keepUnsaved(tokens, receivedAt, s, discovery);
          const code = errnoOf(e);
          throw new TokenSaveFailed(`lumberroom renewed the sign-in and could not save it (${code ?? reason(e)}).`, code);
        }
        if (forced) this.renewedAfter401 = tokens.access_token;
        this.reload();
      },
      { timeoutMs: this.fenceTimeoutMs },
    );
  }

  // The branches read the status fetchFn recorded, never the error class: parseErrorResponse picks
  // the class from the body's error code, so a 503 saying temporarily_unavailable arrives as an
  // OAuthError that is not a ServerError (spec S7).
  private refreshFailed(e: unknown, grant: { sent: boolean; status: number | null }, fence: FenceHandle): never {
    if (!grant.sent) {
      // After a compromise the lock and the file are a peer's; our marker stays and tells it the
      // token may be spent.
      if (!fence.compromised()) this.clearMarker();
      throw new RefreshUnavailable(`the lumberroom token refresh was not sent (${reason(e)})`);
    }
    const status = grant.status;
    if (status === null || (status >= 200 && status < 300)) {
      // Sent with no usable answer. The engine may have rotated already; a lost answer costs one sign-in.
      this.forgetRefreshToken();
      throw new LoginRequired(`a lumberroom token refresh got no answer, so the stored sign-in cannot be trusted. ${RUN_LOGIN}`);
    }
    this.clearMarker();
    if (status >= 500) throw new RefreshUnavailable(`the lumberroom token refresh failed (HTTP ${status}): ${reason(e)}`);
    this.refusedAt = this.seen;
    throw new LoginRequired(`lumberroom refused the stored sign-in (HTTP ${status}). ${RUN_LOGIN}`);
  }

  private clearMarker(): void {
    // A file that is gone stays gone; writing the marker back would create a signed-out file.
    if (this.store.version() !== 0n) {
      try {
        this.store.write({ refreshStartedAt: null });
      } catch {
        // The marker stays, and the next holder drops the refresh token rather than present it.
      }
    }
    this.reload();
  }

  private forgetRefreshToken(): void {
    try {
      this.store.dropRefreshToken();
    } catch {
      // The drop failed and the file still carries the token: refuse it here until the file changes.
      // Peers see the in-flight marker and drop it themselves.
      this.reload();
      this.refusedAt = this.seen;
      return;
    }
    this.reload();
  }

  private keepUnsaved(tokens: OAuthTokens, receivedAt: number, s: StoredOAuth, discovery: StoredDiscovery): void {
    // Take the spent refresh token off disk so no peer, and no later process, presents it. Dropping
    // the field rewrites the file, which a full disk refuses; unlinking needs no space.
    try {
      this.store.dropRefreshToken();
    } catch {
      try {
        this.store.clear();
      } catch {
        // Both refused. The in-flight marker is still on disk, so a peer drops the token before sending it.
      }
    }
    const ttl = tokens.expires_in;
    this.unsaved = {
      tokens,
      expiresAt: typeof ttl === "number" && Number.isFinite(ttl) ? receivedAt + ttl * 1000 : null,
      clientInformation: s.clientInformation,
      discovery,
      resource: s.resource,
      marker: this.store.version(),
    };
    this.reload();
  }

  private async saveFenced(): Promise<void> {
    const pending = this.unsaved!;
    await withFence(
      this.lock,
      async () => {
        // Any change since the spent token came off disk is a sign-in or a sign-out, and it wins.
        if (this.store.version() === pending.marker) {
          try {
            this.store.write({
              tokens: pending.tokens,
              expiresAt: pending.expiresAt,
              clientInformation: pending.clientInformation,
              discovery: pending.discovery,
              resource: pending.resource,
              refreshStartedAt: null,
            });
          } catch (e) {
            const code = errnoOf(e);
            throw new TokenSaveFailed(`lumberroom renewed the sign-in and still cannot save it (${code ?? reason(e)}).`, code);
          }
        }
        this.unsaved = null;
        this.reload();
      },
      { timeoutMs: this.fenceTimeoutMs },
    );
  }
}

export function createOAuthAuth(cfg: LumberroomConfig, opts: OAuthAuthOptions): AuthHandle & { status(): OAuthStatus } {
  return new OAuthAuth(cfg, opts);
}
