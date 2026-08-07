const TOKEN_URL = "https://oauth2.googleapis.com/token";

const tokenCache = new Map<string, { token: string; expiresAt: number }>();

/**
 * Exchange a refresh token for a short-lived access token, cached per
 * (clientId, refreshToken) until ~30s before expiry. Shared by every Google
 * API surface — the scope is determined by whatever scopes were granted when
 * the refresh token was issued, so a single token can cover Gmail + Calendar
 * if the user consented to both.
 */
export async function accessTokenFor(
  clientId: string,
  clientSecret: string,
  refreshToken: string
): Promise<string> {
  const cacheKey = `${clientId}::${refreshToken}`;
  const hit = tokenCache.get(cacheKey);
  if (hit && hit.expiresAt > Date.now() + 30_000) return hit.token;

  const body = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    refresh_token: refreshToken,
    grant_type: "refresh_token",
  });
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Google token exchange failed (${res.status}): ${text.slice(0, 200)}`);
  }
  const data = (await res.json()) as {
    access_token: string;
    expires_in?: number;
  };
  if (!data.access_token) throw new Error("Google token response missing access_token");
  const expiresAt = Date.now() + (data.expires_in ?? 3600) * 1000;
  tokenCache.set(cacheKey, { token: data.access_token, expiresAt });
  return data.access_token;
}
