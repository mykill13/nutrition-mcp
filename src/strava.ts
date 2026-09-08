// Strava API v3 client for the dashboard's "Movement" card. Pure fetch/token
// logic, deliberately free of Supabase access — same separation convention as
// src/patreon.ts: takes an injected StravaTokenStore rather than calling
// getSupabase() itself.
//
// Single owner, single token pair (see strava_tokens migration) — this is a
// personal dashboard, not a multi-tenant integration, so there is no per-user
// lookup here at all.

const OAUTH_AUTHORIZE_URL = "https://www.strava.com/oauth/authorize";
const TOKEN_URL = "https://www.strava.com/oauth/token";
const API_BASE = "https://www.strava.com/api/v3";
const REQUEST_TIMEOUT_MS = 8_000;
// Refresh proactively once the stored token is this close to expiring, so a
// dashboard load never races an access token going stale mid-request.
const REFRESH_MARGIN_MS = 5 * 60 * 1000;
// Scope needed to read activity history, including private activities (a
// Peloton ride synced through Strava's own "keep private" default setting
// would otherwise be invisible to activity:read).
const SCOPE = "activity:read_all";

export interface StravaTokens {
    accessToken: string;
    refreshToken: string;
    expiresAt: string; // ISO 8601
}

export interface StravaTokenStore {
    getTokens(): Promise<StravaTokens | null>;
    saveTokens(tokens: StravaTokens): Promise<void>;
}

export interface StravaConfig {
    clientId: string;
    clientSecret: string;
}

export interface StravaActivity {
    name: string;
    type: string;
    calories: number | null;
    movingMinutes: number;
    startDate: string; // ISO 8601
}

interface StravaTokenResponse {
    access_token: string;
    refresh_token: string;
    expires_at: number; // unix seconds
}

interface StravaActivitySummary {
    id: number;
    name: string;
    type: string;
    moving_time: number; // seconds
    start_date: string;
}

interface StravaActivityDetail extends StravaActivitySummary {
    calories?: number | null;
}

/** Where to send the owner to grant access. `redirectUri` must exactly match
 *  the callback route registered below and the domain entered on Strava's
 *  API application page. */
export function buildAuthorizeUrl(
    config: StravaConfig,
    redirectUri: string,
    state: string,
): string {
    const params = new URLSearchParams({
        client_id: config.clientId,
        redirect_uri: redirectUri,
        response_type: "code",
        approval_prompt: "auto",
        scope: SCOPE,
        state,
    });
    return `${OAUTH_AUTHORIZE_URL}?${params.toString()}`;
}

/** Exchanges the one-time `code` from the OAuth redirect for a token pair.
 *  Called exactly once, from the /strava/callback route. */
export async function exchangeCodeForTokens(
    code: string,
    config: StravaConfig,
): Promise<StravaTokens> {
    const res = await fetch(TOKEN_URL, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
            client_id: config.clientId,
            client_secret: config.clientSecret,
            code,
            grant_type: "authorization_code",
        }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!res.ok) {
        throw new Error(`Strava code exchange failed: ${res.status}`);
    }
    const data = (await res.json()) as StravaTokenResponse;
    if (!data.access_token || !data.refresh_token) {
        throw new Error("Strava code exchange response missing tokens");
    }
    return {
        accessToken: data.access_token,
        refreshToken: data.refresh_token,
        expiresAt: new Date(data.expires_at * 1000).toISOString(),
    };
}

// Concurrent callers WITHIN THIS PROCESS must share one in-flight refresh —
// same reasoning as src/patreon.ts's refreshInFlight: Strava can rotate the
// refresh token on use, so two concurrent refreshes racing on the same stored
// token is a real failure mode, not a theoretical one. Cleared once the
// promise settles so a later expiry triggers a fresh refresh rather than
// reusing a long-resolved promise. Process-local only — see
// refreshAndPersist's recovery branch for the multi-replica case.
let refreshInFlight: Promise<StravaTokens> | null = null;

async function refreshTokens(
    refreshToken: string,
    config: StravaConfig,
): Promise<StravaTokens> {
    const res = await fetch(TOKEN_URL, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
            client_id: config.clientId,
            client_secret: config.clientSecret,
            refresh_token: refreshToken,
            grant_type: "refresh_token",
        }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!res.ok) {
        throw new Error(`Strava token refresh failed: ${res.status}`);
    }
    const data = (await res.json()) as StravaTokenResponse;
    if (!data.access_token || !data.refresh_token) {
        throw new Error("Strava token refresh response missing tokens");
    }
    return {
        accessToken: data.access_token,
        refreshToken: data.refresh_token,
        expiresAt: new Date(data.expires_at * 1000).toISOString(),
    };
}

// Same "another replica may have already fixed it" recovery as
// src/patreon.ts's refreshAndPersist — see that comment for the full
// reasoning. Re-reads the store once on failure rather than propagating
// immediately.
async function refreshAndPersist(
    store: StravaTokenStore,
    tokens: StravaTokens,
    config: StravaConfig,
): Promise<StravaTokens> {
    try {
        const refreshed = await refreshTokens(tokens.refreshToken, config);
        await store.saveTokens(refreshed);
        return refreshed;
    } catch (err) {
        const current = await store.getTokens();
        if (current && current.accessToken !== tokens.accessToken) {
            return current;
        }
        throw err;
    }
}

/** A valid access token, refreshing proactively within REFRESH_MARGIN_MS of
 *  expiry. Returns null when Strava has never been connected — the caller
 *  (getTodaysMovement) treats that as "nothing to show", not an error. */
async function getValidAccessToken(
    store: StravaTokenStore,
    config: StravaConfig,
): Promise<string | null> {
    const tokens = await store.getTokens();
    if (!tokens) return null;

    const expiresAt = new Date(tokens.expiresAt).getTime();
    if (expiresAt - Date.now() > REFRESH_MARGIN_MS) {
        return tokens.accessToken;
    }

    if (!refreshInFlight) {
        refreshInFlight = refreshAndPersist(store, tokens, config).finally(
            () => {
                refreshInFlight = null;
            },
        );
    }
    const refreshed = await refreshInFlight;
    return refreshed.accessToken;
}

/**
 * Today's activities (in the given local day window) with calories, newest
 * first. Returns [] when Strava has never been connected. Any other failure
 * (refresh failure, non-2xx response, network error) propagates — it's the
 * caller's job (src/dashboard.ts) to catch that and degrade gracefully.
 *
 * The list endpoint (`/athlete/activities`) does not reliably return
 * `calories` — Strava's own docs only show it on the single-activity detail
 * response — so each activity in the window is re-fetched individually. A
 * personal dashboard sees at most a handful of activities a day, so this
 * stays cheap and well inside Strava's rate limits (100/15min, 1000/day).
 */
export async function getTodaysMovement(
    store: StravaTokenStore,
    config: StravaConfig,
    dayStartUtc: Date,
    dayEndUtc: Date,
): Promise<StravaActivity[]> {
    const accessToken = await getValidAccessToken(store, config);
    if (!accessToken) return [];

    const after = Math.floor(dayStartUtc.getTime() / 1000);
    const before = Math.floor(dayEndUtc.getTime() / 1000);
    const listUrl = `${API_BASE}/athlete/activities?after=${after}&before=${before}&per_page=30`;
    const listRes = await fetch(listUrl, {
        headers: { Authorization: `Bearer ${accessToken}` },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!listRes.ok) {
        throw new Error(`Strava activities request failed: ${listRes.status}`);
    }
    const summaries = (await listRes.json()) as StravaActivitySummary[];
    if (summaries.length === 0) return [];

    const details = await Promise.all(
        summaries.map(async (s) => {
            const res = await fetch(`${API_BASE}/activities/${s.id}`, {
                headers: { Authorization: `Bearer ${accessToken}` },
                signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
            });
            // A single activity detail failing (rare) shouldn't blank the
            // whole card — fall back to the summary with calories unknown.
            if (!res.ok) return s as StravaActivityDetail;
            return (await res.json()) as StravaActivityDetail;
        }),
    );

    return details
        .sort((a, b) => b.start_date.localeCompare(a.start_date))
        .map((d) => ({
            name: d.name,
            type: d.type,
            calories: d.calories ?? null,
            movingMinutes: Math.round(d.moving_time / 60),
            startDate: d.start_date,
        }));
}
