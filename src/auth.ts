export const RING_OAUTH_TOKEN_URL = 'https://oauth.ring.com/oauth/token';

/** Supplies a Bearer access token for each API call. */
export interface TokenProvider {
  getAccessToken(): Promise<string>;
  /** Called after a 401 so the next call fetches a fresh token. */
  invalidate?(): void;
}

/** A fixed access token, such as the 30-minute token from the Ring Developer Playground. */
export class StaticTokenProvider implements TokenProvider {
  readonly #token: string;

  constructor(token: string) {
    if (!token) throw new Error('StaticTokenProvider: token is empty');
    this.#token = token;
  }

  async getAccessToken(): Promise<string> {
    return this.#token;
  }
}

export interface TokenSet {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  scope?: string;
}

export interface RefreshTokenProviderOptions {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  /** Ring rotates refresh tokens: persist the new one or the user must re-link in ~30 days. */
  onRotate?: (tokens: TokenSet) => void | Promise<void>;
  tokenUrl?: string;
  fetch?: typeof fetch;
  /** Refresh this long before expiry. Defaults to 60 s. */
  skewMs?: number;
  now?: () => number;
}

/**
 * Exchanges a refresh token for access tokens (POST https://oauth.ring.com/oauth/token,
 * form-encoded) and caches the access token until shortly before it expires.
 * Concurrent callers share one in-flight refresh.
 */
export class RefreshTokenProvider implements TokenProvider {
  readonly #opts: RefreshTokenProviderOptions;
  #refreshToken: string;
  #cached?: TokenSet;
  #inflight?: Promise<string>;

  constructor(opts: RefreshTokenProviderOptions) {
    if (!opts.clientId || !opts.clientSecret || !opts.refreshToken) {
      throw new Error('RefreshTokenProvider: clientId, clientSecret and refreshToken are all required');
    }
    this.#opts = opts;
    this.#refreshToken = opts.refreshToken;
  }

  invalidate(): void {
    this.#cached = undefined;
  }

  async getAccessToken(): Promise<string> {
    const now = (this.#opts.now ?? Date.now)();
    const skew = this.#opts.skewMs ?? 60_000;
    if (this.#cached && now < this.#cached.expiresAt - skew) return this.#cached.accessToken;
    this.#inflight ??= this.#refresh().finally(() => {
      this.#inflight = undefined;
    });
    return this.#inflight;
  }

  async #refresh(): Promise<string> {
    const doFetch = this.#opts.fetch ?? fetch;
    const body = new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: this.#refreshToken,
      client_id: this.#opts.clientId,
      client_secret: this.#opts.clientSecret,
    });
    const res = await doFetch(this.#opts.tokenUrl ?? RING_OAUTH_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`Ring token refresh failed: ${res.status} ${text.slice(0, 200)}`);
    }
    const json = (await res.json()) as {
      access_token: string;
      refresh_token?: string;
      expires_in?: number;
      scope?: string;
    };
    const now = (this.#opts.now ?? Date.now)();
    const tokens: TokenSet = {
      accessToken: json.access_token,
      refreshToken: json.refresh_token ?? this.#refreshToken,
      expiresAt: now + (json.expires_in ?? 14_400) * 1000,
      scope: json.scope,
    };
    this.#refreshToken = tokens.refreshToken;
    this.#cached = tokens;
    await this.#opts.onRotate?.(tokens);
    return tokens.accessToken;
  }
}
