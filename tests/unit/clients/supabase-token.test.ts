import { describe, it, expect, jest } from "@jest/globals";
import {
  getSupabaseEnv,
  refreshViaEdgeFunction,
  pullRefreshTokenFromSupabase,
  QboReauthRequiredError,
  type SupabaseEnv,
} from "../../../src/clients/supabase-token.js";

const CFG: SupabaseEnv = {
  url: "https://proj.supabase.co",
  serviceKey: "service-key-123",
};

function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as unknown as Response;
}

describe("getSupabaseEnv", () => {
  it("returns config when both vars are present", () => {
    const cfg = getSupabaseEnv({
      SUPABASE_URL: "https://proj.supabase.co",
      SUPABASE_SERVICE_ROLE_KEY: "key",
    } as NodeJS.ProcessEnv);
    expect(cfg).toEqual({ url: "https://proj.supabase.co", serviceKey: "key" });
  });

  it("strips a trailing slash from the URL", () => {
    const cfg = getSupabaseEnv({
      SUPABASE_URL: "https://proj.supabase.co/",
      SUPABASE_SERVICE_ROLE_KEY: "key",
    } as NodeJS.ProcessEnv);
    expect(cfg?.url).toBe("https://proj.supabase.co");
  });

  it("returns null when the URL is missing", () => {
    expect(
      getSupabaseEnv({ SUPABASE_SERVICE_ROLE_KEY: "key" } as NodeJS.ProcessEnv),
    ).toBeNull();
  });

  it("returns null when the service key is missing", () => {
    expect(
      getSupabaseEnv({
        SUPABASE_URL: "https://proj.supabase.co",
      } as NodeJS.ProcessEnv),
    ).toBeNull();
  });
});

describe("refreshViaEdgeFunction", () => {
  it("calls the Edge Function with the correct URL, auth header and body", async () => {
    const fetchImpl = jest
      .fn<typeof fetch>()
      .mockResolvedValue(
        jsonResponse(200, { access_token: "AT", realm_id: "R1", refreshed: true }),
      );

    await refreshViaEdgeFunction(CFG, fetchImpl);

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://proj.supabase.co/functions/v1/qb-token-refresh");
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>).Authorization).toBe(
      "Bearer service-key-123",
    );
    expect(init.body).toBe("{}");
  });

  it("returns the access token and realm id on a fresh refresh", async () => {
    const fetchImpl = jest
      .fn<typeof fetch>()
      .mockResolvedValue(
        jsonResponse(200, { access_token: "AT", realm_id: "R1", refreshed: true }),
      );

    const result = await refreshViaEdgeFunction(CFG, fetchImpl);
    expect(result).toEqual({ accessToken: "AT", realmId: "R1", refreshed: true });
  });

  it("reports refreshed=false when a cached token is returned", async () => {
    const fetchImpl = jest
      .fn<typeof fetch>()
      .mockResolvedValue(
        jsonResponse(200, { access_token: "AT", realm_id: "R1", refreshed: false }),
      );

    const result = await refreshViaEdgeFunction(CFG, fetchImpl);
    expect(result.refreshed).toBe(false);
  });

  it("throws QboReauthRequiredError on HTTP 401 (dead refresh token)", async () => {
    const fetchImpl = jest
      .fn<typeof fetch>()
      .mockResolvedValue(jsonResponse(401, { error: "invalid_grant" }));

    await expect(refreshViaEdgeFunction(CFG, fetchImpl)).rejects.toBeInstanceOf(
      QboReauthRequiredError,
    );
  });

  it("throws a plain Error on a non-401 failure (transient)", async () => {
    const fetchImpl = jest
      .fn<typeof fetch>()
      .mockResolvedValue(jsonResponse(502, { error: "bad gateway" }));

    const err = await refreshViaEdgeFunction(CFG, fetchImpl).catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(QboReauthRequiredError);
    expect((err as Error).message).toContain("HTTP 502");
  });

  it("throws when the response has no access_token", async () => {
    const fetchImpl = jest
      .fn<typeof fetch>()
      .mockResolvedValue(jsonResponse(200, { refreshed: true, error: "weird" }));

    await expect(refreshViaEdgeFunction(CFG, fetchImpl)).rejects.toThrow(
      /no access_token: weird/,
    );
  });
});

describe("pullRefreshTokenFromSupabase", () => {
  it("returns the latest refresh token from qb_tokens", async () => {
    const fetchImpl = jest
      .fn<typeof fetch>()
      .mockResolvedValue(jsonResponse(200, [{ refresh_token: "RT-new" }]));

    const token = await pullRefreshTokenFromSupabase(CFG, fetchImpl);
    expect(token).toBe("RT-new");

    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toContain("/rest/v1/qb_tokens?select=refresh_token");
    expect((init.headers as Record<string, string>).apikey).toBe("service-key-123");
  });

  it("returns null when there are no rows", async () => {
    const fetchImpl = jest
      .fn<typeof fetch>()
      .mockResolvedValue(jsonResponse(200, []));

    expect(await pullRefreshTokenFromSupabase(CFG, fetchImpl)).toBeNull();
  });

  it("returns null when the row has no refresh_token", async () => {
    const fetchImpl = jest
      .fn<typeof fetch>()
      .mockResolvedValue(jsonResponse(200, [{}]));

    expect(await pullRefreshTokenFromSupabase(CFG, fetchImpl)).toBeNull();
  });

  it("returns null on a non-ok response", async () => {
    const fetchImpl = jest
      .fn<typeof fetch>()
      .mockResolvedValue(jsonResponse(500, { error: "boom" }));

    expect(await pullRefreshTokenFromSupabase(CFG, fetchImpl)).toBeNull();
  });
});
