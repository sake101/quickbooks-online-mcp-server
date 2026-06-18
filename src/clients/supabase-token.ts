// Supabase-backed QBO token authority.
//
// QuickBooks Online has several independent consumers of the SAME Intuit
// connection: this MCP server, the daily accounting agent, and the Command
// Center web app. Intuit rotates the refresh token on every refresh and
// invalidates the previous one. So any long-running consumer that caches a
// refresh token in memory and refreshes *directly* against Intuit will
// eventually present a token that another consumer has already rotated out —
// Intuit answers `400 invalid_grant`, and the failure looks (wrongly) like the
// connection needs a fresh OAuth login at the Command Center / Vercel.
//
// The fix: route refresh through the Supabase Edge Function `qb-token-refresh`,
// which is the single serialized authority. It always reads the current token
// from the `qb_tokens` table, refreshes against Intuit under optimistic
// concurrency, persists the rotation, and returns a valid access token. It only
// returns HTTP 401 when the *stored* refresh token is itself dead — which is the
// one and only case where a human actually has to reconnect QBO.

export interface SupabaseEnv {
  url: string;
  serviceKey: string;
}

type FetchLike = typeof fetch;

/**
 * Raised only when the refresh token stored in Supabase is itself invalid
 * (Intuit `invalid_grant`). This is the sole condition that requires a human to
 * reconnect QuickBooks at the Command Center — every other failure is transient
 * and should be retried, not escalated to a re-auth.
 */
export class QboReauthRequiredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "QboReauthRequiredError";
  }
}

/**
 * Resolve Supabase credentials from the environment. Returns null when they are
 * absent (e.g. the server is run standalone, outside the CSC deployment) so the
 * caller can fall back to a direct Intuit refresh.
 */
export function getSupabaseEnv(
  env: NodeJS.ProcessEnv = process.env,
): SupabaseEnv | null {
  const url = env.SUPABASE_URL;
  const serviceKey = env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceKey) return null;
  return { url: url.replace(/\/+$/, ""), serviceKey };
}

export interface EdgeRefreshResult {
  accessToken: string;
  realmId?: string;
  /** true when the Edge Function minted a new access token, false when it
   *  returned a still-valid cached one. */
  refreshed: boolean;
}

/**
 * Obtain a valid access token from the serialized Supabase Edge Function.
 * Throws {@link QboReauthRequiredError} on a genuine dead-token (HTTP 401),
 * and a plain Error on any other (transient) failure so the caller can fall
 * back to a direct refresh.
 */
export async function refreshViaEdgeFunction(
  cfg: SupabaseEnv,
  fetchImpl: FetchLike = fetch,
): Promise<EdgeRefreshResult> {
  const res = await fetchImpl(`${cfg.url}/functions/v1/qb-token-refresh`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${cfg.serviceKey}`,
      "Content-Type": "application/json",
    },
    body: "{}",
  });

  if (res.status === 401) {
    throw new QboReauthRequiredError(
      "QBO refresh token is invalid in Supabase. Reconnect QuickBooks at the Command Center (Connect QBO) — re-running this will not help until then.",
    );
  }

  if (!res.ok) {
    throw new Error(
      `qb-token-refresh Edge Function returned HTTP ${res.status}`,
    );
  }

  const data = (await res.json()) as {
    access_token?: string;
    realm_id?: string;
    refreshed?: boolean;
    error?: string;
  };

  if (!data.access_token) {
    throw new Error(
      `qb-token-refresh Edge Function returned no access_token${
        data.error ? `: ${data.error}` : ""
      }`,
    );
  }

  return {
    accessToken: data.access_token,
    realmId: data.realm_id,
    refreshed: data.refreshed === true,
  };
}

/**
 * Read the current refresh token straight from the `qb_tokens` table. Used by
 * the direct-refresh fallback to self-heal: if a direct Intuit refresh fails
 * because our in-memory token was rotated out by another consumer, we re-pull
 * the authoritative token from Supabase and retry once. Returns null on any
 * failure (caller treats that as "no newer token available").
 */
export async function pullRefreshTokenFromSupabase(
  cfg: SupabaseEnv,
  fetchImpl: FetchLike = fetch,
): Promise<string | null> {
  const res = await fetchImpl(
    `${cfg.url}/rest/v1/qb_tokens?select=refresh_token&order=updated_at.desc&limit=1`,
    {
      headers: {
        apikey: cfg.serviceKey,
        Authorization: `Bearer ${cfg.serviceKey}`,
      },
    },
  );
  if (!res.ok) return null;
  const rows = (await res.json()) as Array<{ refresh_token?: string }>;
  return rows?.[0]?.refresh_token ?? null;
}
