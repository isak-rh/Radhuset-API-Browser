// Resolves the credentials an API should send, fetching and caching OAuth2 tokens.
//
// The invariant this module exists to keep:
//
//   Tokens are cached against the credentials that obtained them —
//   (token URL, client ID, client secret) — never against an API name, and a
//   token's expiry deadline is stamped exactly once, when it is issued.
//
// Several APIs normally share one profile (the STAC endpoints use one set of
// client credentials, the NGP endpoints another). Keying by API would copy one
// token into one slot per API, each with its own clock; keying by credentials
// gives one entry per credential set, so the clock cannot drift. Editing any
// credential field yields a new key, which is what makes a cached token
// unreachable after a profile edit — there is no invalidation to remember.
//
// Tokens live in memory only. Concurrent requests for the same credentials share
// a single token request.

import { toBase64 } from '../lib/crypto.js';
import { request, responseDetail } from '../lib/http.js';
import { t } from '../i18n/index.js';
import { missingFields } from './profiles.js';
import { VaultLockedError } from './vault.js';

// Refresh this long before the stated expiry: a single download can run for
// minutes after the check that let it start.
const EXPIRY_SKEW_MS = 120_000;

export class AuthError extends Error {
  constructor(message) {
    super(message);
    this.name = 'AuthError';
  }
}

export class IncompleteProfileError extends AuthError {
  constructor(profile, missing) {
    super(t('session.incompleteProfile', { name: profile.name, fields: missing.join(` ${t('common.and')} `) }));
    this.name = 'IncompleteProfileError';
    this.profile = profile;
  }
}

export class TokenFetchError extends AuthError {
  constructor(message) {
    super(message);
    this.name = 'TokenFetchError';
  }
}

/** POST a client-credentials grant and return the token response. */
export async function requestToken(profile, { signal } = {}) {
  let response;
  try {
    response = await request(profile.tokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: new URLSearchParams({
        grant_type: 'client_credentials',
        client_id: profile.clientId,
        client_secret: profile.clientSecret,
      }),
      signal,
    });
  } catch (error) {
    if (error?.name === 'AbortError') throw error;
    throw new TokenFetchError(error.message);
  }
  if (!response.ok) {
    const detail = await responseDetail(response);
    const hint = response.status === 400 || response.status === 401
      ? t('session.checkClientIdSecret')
      : '';
    throw new TokenFetchError(
      `${t('session.tokenEndpointAnswered', { status: response.status })}${detail ? `: ${detail}` : '.'}${hint}`,
    );
  }
  let data = null;
  try {
    data = await response.json();
  } catch {
    /* fall through */
  }
  if (!data || typeof data.access_token !== 'string' || !data.access_token) {
    throw new TokenFetchError(t('session.tokenEndpointNoToken'));
  }
  return data;
}

const keyOf = (profile) => JSON.stringify([profile.tokenUrl.trim(), profile.clientId.trim(), profile.clientSecret]);

/** The single place a token's deadline is computed: when it has just been issued. */
function stamp(data) {
  const seconds = Number(data.expires_in);
  const type = String(data.token_type || 'Bearer');
  return {
    accessToken: data.access_token,
    tokenType: type.charAt(0).toUpperCase() + type.slice(1).toLowerCase(),
    // No usable TTL: treat as already expired rather than guess.
    expiresAt: Number.isFinite(seconds) && seconds > 0 ? performance.now() + seconds * 1000 : null,
  };
}

const isExpired = (token) => token.expiresAt === null || performance.now() >= token.expiresAt - EXPIRY_SKEW_MS;

const oauthCredentials = (token) => ({
  type: 'oauth2',
  token: token.accessToken,
  authorization: `${token.tokenType} ${token.accessToken}`,
});

export class AuthSession {
  #tokens = new Map();
  #pending = new Map();

  constructor(profiles, bindings, vault) {
    this.profiles = profiles;
    this.bindings = bindings;
    this.vault = vault;
    // Drops tokens whose credentials no longer belong to any available profile:
    // after an edit, a delete — and on lock, so a locked vault leaves no usable
    // token behind.
    profiles.on('change', () => this.prune());
  }

  /**
   * The profile bound to *apiName*, or null. Throws VaultLockedError when the
   * binding points at a profile that may be in the locked vault.
   */
  profileFor(apiName) {
    const id = this.bindings.get(apiName);
    if (!id) return null;
    const profile = this.profiles.get(id);
    if (profile) return profile;
    if (this.vault.exists && !this.vault.unlocked) throw new VaultLockedError();
    return null;
  }

  /**
   * Credentials for *apiName* as { type, authorization, token? }, or null when no
   * profile is bound. Whether null is an error depends on the API's auth
   * requirement, which is the caller's business. Throws VaultLockedError,
   * IncompleteProfileError or TokenFetchError.
   */
  async credentialsFor(apiName) {
    const profile = this.profileFor(apiName);
    if (!profile) return null;
    const missing = missingFields(profile);
    if (missing.length) throw new IncompleteProfileError(profile, missing);

    if (profile.type === 'basic') {
      const pair = new TextEncoder().encode(`${profile.username}:${profile.password}`);
      return { type: 'basic', authorization: `Basic ${toBase64(pair)}` };
    }
    const key = keyOf(profile);
    let token = this.#tokens.get(key);
    if (!token || isExpired(token)) token = await this.#fetch(profile, key);
    return oauthCredentials(token);
  }

  /**
   * A new token for *apiName*, ignoring the cached expiry. This is the path for a
   * 401 on a token our own clock still considers valid, so it must not consult
   * the expiry. If *rejectedToken* is no longer the cached one, another request
   * already refreshed it and that token is returned instead. Null when the API
   * has no usable OAuth2 profile.
   */
  async refresh(apiName, rejectedToken) {
    let profile;
    try {
      profile = this.profileFor(apiName);
    } catch {
      return null;
    }
    if (!profile || profile.type !== 'oauth2' || missingFields(profile).length) return null;
    const key = keyOf(profile);
    const cached = this.#tokens.get(key);
    if (rejectedToken && cached && cached.accessToken !== rejectedToken) return oauthCredentials(cached);
    try {
      return oauthCredentials(await this.#fetch(profile, key));
    } catch {
      return null;
    }
  }

  /** Cache a token fetched elsewhere (the profile editor's Test button). */
  seed(profile, tokenData) {
    this.#tokens.set(keyOf(profile), stamp(tokenData));
  }

  clear() {
    this.#tokens.clear();
  }

  prune() {
    const live = new Set(this.profiles.all().filter((p) => p.type === 'oauth2').map(keyOf));
    for (const key of [...this.#tokens.keys()]) if (!live.has(key)) this.#tokens.delete(key);
  }

  get cachedTokenCount() {
    return this.#tokens.size;
  }

  /** Names of bound APIs whose profile shares *profile*'s credentials. */
  apisUsing(profile) {
    const key = keyOf(profile);
    return Object.entries(this.bindings.entries())
      .filter(([, id]) => {
        const bound = this.profiles.get(id);
        return bound && bound.type === 'oauth2' && keyOf(bound) === key;
      })
      .map(([api]) => api);
  }

  #fetch(profile, key) {
    const pending = this.#pending.get(key);
    if (pending) return pending;
    const promise = requestToken(profile)
      .then((data) => {
        const token = stamp(data);
        this.#tokens.set(key, token);
        return token;
      })
      .finally(() => this.#pending.delete(key));
    this.#pending.set(key, promise);
    return promise;
  }
}
