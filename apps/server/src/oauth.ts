import crypto from "node:crypto";
import { Hono, type Context } from "hono";
import { z } from "zod";
import { config } from "./config.ts";
import { all, now, one, run, uid } from "./db.ts";
import { rateLimited } from "./session.ts";
import { getUser, type User } from "./store.ts";

// OAuth 2.1 for the MCP server, as MCP clients (Claude Desktop, Claude Code, claude.ai connectors) expect it:
// protected-resource and authorization-server metadata, dynamic client registration, authorization code + PKCE (S256)
// with Ferry's own consent screen, and rotating refresh tokens. Scopes: jobs:read (see) and jobs:apply (act).

export const OAUTH_SCOPES = ["jobs:read", "jobs:apply"] as const;
export type OAuthScope = (typeof OAUTH_SCOPES)[number];
const ACCESS_TTL_S = 3600;
const REFRESH_TTL_DAYS = 60;

const sha = (s: string) => crypto.createHash("sha256").update(s).digest("hex");
const secret = (prefix: string) => `${prefix}_${crypto.randomBytes(32).toString("base64url")}`;
const inSeconds = (s: number) => new Date(Date.now() + s * 1000).toISOString();
const base = () => config.publicUrl.replace(/\/$/, "");
export const resourceMetadataUrl = () => `${base()}/.well-known/oauth-protected-resource`;

/** Scopes asked for, limited to the ones that exist; jobs:read is always included. */
const scopesOf = (s?: string | null) => {
  const asked = (s ?? "jobs:read jobs:apply").split(/[\s,]+/).filter((x): x is OAuthScope => (OAUTH_SCOPES as readonly string[]).includes(x));
  return [...new Set<OAuthScope>(["jobs:read", ...asked])];
};

/** The user and scopes behind an OAuth access token, or null. */
export function oauthUser(token: string): { user: User; scopes: Set<OAuthScope> } | null {
  if (!token.startsWith("fmcp_")) return null;
  const r = one<{ user_id: string; scope: string; expires_at: string }>("SELECT user_id, scope, expires_at FROM mcp_oauth_tokens WHERE access_hash = ?", sha(token));
  if (!r || r.expires_at < now()) return null;
  const user = getUser(r.user_id);
  return user ? { user, scopes: new Set(r.scope.split(" ") as OAuthScope[]) } : null;
}

/** Redirect URIs a client may register: https anywhere, http only to this machine (native apps, Claude Code). */
const okRedirect = (u: string) => {
  try {
    const url = new URL(u);
    return url.protocol === "https:" || (url.protocol === "http:" && /^(localhost|127\.0\.0\.1|\[::1\])$/.test(url.hostname));
  } catch {
    return false;
  }
};

// ---------- public endpoints (mounted at the site root) ----------

export const oauth = new Hono();
const limited = (c: Context, key: string, max: number) => rateLimited(`${key}:${c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ?? "local"}`, max, 10 * 60_000);

const protectedResource = (c: Context) =>
  c.json({ resource: `${base()}/api/v1/mcp`, authorization_servers: [base()], scopes_supported: OAUTH_SCOPES, bearer_methods_supported: ["header"], resource_name: `${config.brand} job applications` });
oauth.get("/.well-known/oauth-protected-resource", protectedResource);
oauth.get("/.well-known/oauth-protected-resource/api/v1/mcp", protectedResource);

oauth.get("/.well-known/oauth-authorization-server", (c) =>
  c.json({
    issuer: base(),
    authorization_endpoint: `${base()}/oauth/authorize`,
    token_endpoint: `${base()}/oauth/token`,
    registration_endpoint: `${base()}/oauth/register`,
    revocation_endpoint: `${base()}/oauth/revoke`,
    scopes_supported: OAUTH_SCOPES,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none"],
  }),
);

/** Dynamic client registration (RFC 7591): public clients, PKCE required. */
oauth.post("/oauth/register", async (c) => {
  if (limited(c, "oauth-register", 30)) return c.json({ error: "slow_down" }, 429);
  const b = z
    .object({ client_name: z.string().max(120).optional(), redirect_uris: z.array(z.string().max(2000)).min(1).max(10) })
    .safeParse(await c.req.json().catch(() => ({})));
  if (!b.success || !b.data.redirect_uris.every(okRedirect)) return c.json({ error: "invalid_redirect_uri", error_description: "redirect_uris must be https, or http on localhost" }, 400);
  const id = uid("mcpc");
  const name = (b.data.client_name ?? "MCP client").replace(/[<>]/g, "");
  run("INSERT INTO mcp_oauth_clients(id, name, redirect_uris) VALUES(?,?,?)", id, name, JSON.stringify(b.data.redirect_uris));
  return c.json(
    { client_id: id, client_name: name, redirect_uris: b.data.redirect_uris, token_endpoint_auth_method: "none", grant_types: ["authorization_code", "refresh_token"], response_types: ["code"], client_id_issued_at: Math.floor(Date.now() / 1000) },
    201,
  );
});

const client = (id?: string | null) => (id ? one<{ id: string; name: string; redirect_uris: string }>("SELECT id, name, redirect_uris FROM mcp_oauth_clients WHERE id = ?", id) : undefined);
const registered = (cl: { redirect_uris: string }, uri: string) => (JSON.parse(cl.redirect_uris) as string[]).includes(uri);

/** Authorization request: checked here, then the signed-in user decides on Ferry's consent page. */
oauth.get("/oauth/authorize", (c) => {
  const q = c.req.query();
  const cl = client(q.client_id);
  if (!cl) return c.text("Unknown client. Register it first (dynamic client registration).", 400);
  if (!q.redirect_uri || !registered(cl, q.redirect_uri)) return c.text("redirect_uri isn't registered for this client.", 400);
  const back = (params: Record<string, string>) => {
    const u = new URL(q.redirect_uri);
    for (const [k, v] of Object.entries({ ...params, ...(q.state ? { state: q.state } : {}) })) u.searchParams.set(k, v);
    return c.redirect(u.toString());
  };
  if (q.response_type !== "code") return back({ error: "unsupported_response_type" });
  if (!q.code_challenge || (q.code_challenge_method ?? "plain") !== "S256") return back({ error: "invalid_request", error_description: "PKCE with S256 is required" });
  const consent = new URL("/oauth/consent", config.webUrl);
  for (const k of ["client_id", "redirect_uri", "code_challenge", "code_challenge_method", "state"]) if (q[k]) consent.searchParams.set(k, q[k]);
  consent.searchParams.set("scope", scopesOf(q.scope).join(" "));
  return c.redirect(consent.toString());
});

/** Token endpoint: authorization_code (with the PKCE verifier) and refresh_token (rotating). */
oauth.post("/oauth/token", async (c) => {
  if (limited(c, "oauth-token", 120)) return c.json({ error: "slow_down" }, 429);
  const ct = c.req.header("content-type") ?? "";
  const b = (ct.includes("json") ? await c.req.json().catch(() => ({})) : await c.req.parseBody().catch(() => ({}))) as Record<string, string>;
  const fail = (error: string, error_description?: string) => c.json({ error, ...(error_description ? { error_description } : {}) }, 400);
  if (b.grant_type === "authorization_code") {
    const code = one<{ client_id: string; user_id: string; redirect_uri: string; challenge: string; scope: string; expires_at: string }>("SELECT * FROM mcp_oauth_codes WHERE code_hash = ?", sha(String(b.code ?? "")));
    run("DELETE FROM mcp_oauth_codes WHERE code_hash = ?", sha(String(b.code ?? ""))); // one use only
    if (!code || code.expires_at < now()) return fail("invalid_grant", "The code is invalid or expired");
    if (code.client_id !== b.client_id || code.redirect_uri !== b.redirect_uri) return fail("invalid_grant", "client_id or redirect_uri doesn't match");
    const verifier = String(b.code_verifier ?? "");
    if (crypto.createHash("sha256").update(verifier).digest("base64url") !== code.challenge) return fail("invalid_grant", "PKCE verification failed");
    return c.json(issue(code.client_id, code.user_id, code.scope));
  }
  if (b.grant_type === "refresh_token") {
    const t = one<{ id: string; client_id: string; user_id: string; scope: string; refresh_expires_at: string }>("SELECT * FROM mcp_oauth_tokens WHERE refresh_hash = ?", sha(String(b.refresh_token ?? "")));
    if (!t || t.refresh_expires_at < now() || (b.client_id && b.client_id !== t.client_id)) return fail("invalid_grant", "The refresh token is invalid or expired");
    run("DELETE FROM mcp_oauth_tokens WHERE id = ?", t.id); // rotation: the old pair stops working
    return c.json(issue(t.client_id, t.user_id, t.scope));
  }
  return fail("unsupported_grant_type");
});

oauth.post("/oauth/revoke", async (c) => {
  const b = (await c.req.parseBody().catch(() => ({}))) as Record<string, string>;
  const h = sha(String(b.token ?? ""));
  run("DELETE FROM mcp_oauth_tokens WHERE access_hash = ? OR refresh_hash = ?", h, h);
  return c.body(null, 200);
});

function issue(clientId: string, userId: string, scope: string) {
  const access = secret("fmcp");
  const refresh = secret("fmcr");
  run(
    "INSERT INTO mcp_oauth_tokens(id, access_hash, refresh_hash, client_id, user_id, scope, expires_at, refresh_expires_at) VALUES(?,?,?,?,?,?,?,?)",
    uid("tok"),
    sha(access),
    sha(refresh),
    clientId,
    userId,
    scope,
    inSeconds(ACCESS_TTL_S),
    inSeconds(REFRESH_TTL_DAYS * 86400),
  );
  return { access_token: access, token_type: "Bearer", expires_in: ACCESS_TTL_S, refresh_token: refresh, scope };
}

// ---------- signed-in endpoints (mounted under /api/v1) ----------

type Env = { Variables: { user: User } };
export const oauthApi = new Hono<Env>();

/** What the consent page shows: which app is asking, and where it will send you back. */
oauthApi.get("/oauth/client", (c) => {
  const cl = client(c.req.query("client_id"));
  return cl ? c.json({ client_id: cl.id, name: cl.name, redirect_hosts: (JSON.parse(cl.redirect_uris) as string[]).map((u) => new URL(u).host) }) : c.json({ error: "Unknown app" }, 404);
});

/** The user's decision on the consent page: a one-time code back to the app, or access_denied. */
oauthApi.post("/oauth/approve", async (c) => {
  const b = z
    .object({ client_id: z.string(), redirect_uri: z.string(), code_challenge: z.string().min(43).max(128), scope: z.string().optional(), state: z.string().max(2000).optional(), allow: z.boolean() })
    .safeParse(await c.req.json().catch(() => ({})));
  if (!b.success) return c.json({ error: "Bad request" }, 400);
  const cl = client(b.data.client_id);
  if (!cl || !registered(cl, b.data.redirect_uri)) return c.json({ error: "Unknown app or redirect" }, 400);
  const u = new URL(b.data.redirect_uri);
  if (b.data.state) u.searchParams.set("state", b.data.state);
  if (!b.data.allow) {
    u.searchParams.set("error", "access_denied");
    return c.json({ redirect: u.toString() });
  }
  const code = secret("fmcd");
  run(
    "INSERT INTO mcp_oauth_codes(code_hash, client_id, user_id, redirect_uri, challenge, scope, expires_at) VALUES(?,?,?,?,?,?,?)",
    sha(code),
    cl.id,
    c.get("user").id,
    b.data.redirect_uri,
    b.data.code_challenge,
    scopesOf(b.data.scope).join(" "),
    inSeconds(300),
  );
  u.searchParams.set("code", code);
  return c.json({ redirect: u.toString() });
});

/** Apps connected through OAuth (Settings → Connected apps), and disconnecting one. */
oauthApi.get("/oauth/connections", (c) =>
  c.json(
    all<{ client_id: string; name: string; scope: string; connected_at: string }>(
      `SELECT t.client_id, cl.name, MAX(t.scope) AS scope, MIN(t.created_at) AS connected_at FROM mcp_oauth_tokens t JOIN mcp_oauth_clients cl ON cl.id = t.client_id
       WHERE t.user_id = ? AND t.refresh_expires_at > ? GROUP BY t.client_id ORDER BY connected_at DESC`,
      c.get("user").id,
      now(),
    ),
  ),
);
oauthApi.delete("/oauth/connections/:clientId", (c) => {
  run("DELETE FROM mcp_oauth_tokens WHERE user_id = ? AND client_id = ?", c.get("user").id, c.req.param("clientId"));
  return c.json({ ok: true });
});
