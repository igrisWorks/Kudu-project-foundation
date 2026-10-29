import { createHash, createHmac, randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import type { FastifyInstance } from "fastify";

const COOKIE_NAME = "kudu_session";
const PASSWORD_SCRYPT_N = 16_384;
const PASSWORD_SCRYPT_R = 8;
const PASSWORD_SCRYPT_P = 1;
const PASSWORD_SALT_BYTES = 16;
const PASSWORD_KEY_BYTES = 32;
const SESSION_TTL_MS = 8 * 60 * 60 * 1000;
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const MAX_FAILURES_PER_IP = 5;
const MAX_GLOBAL_FAILURES = 30;
const MAX_CONCURRENT_PASSWORD_CHECKS = 2;
const MAX_SESSIONS = 512;
const MAX_RATE_LIMIT_KEYS = 10_000;

export interface AuthConfiguration {
  passwordHash?: string;
  sessionSecret?: string;
  cookieSecure: boolean;
}

interface ParsedPasswordHash {
  salt: Buffer;
  key: Buffer;
}

export interface AuthenticatedSession {
  key: string;
  csrfToken: string;
  expiresAt: number;
}

interface LoginWindow {
  failures: number;
  resetsAt: number;
}

function derivePasswordKey(password: string, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(
      password,
      salt,
      PASSWORD_KEY_BYTES,
      {
        N: PASSWORD_SCRYPT_N,
        r: PASSWORD_SCRYPT_R,
        p: PASSWORD_SCRYPT_P,
        maxmem: 64 * 1024 * 1024,
      },
      (error, key) => error ? reject(error) : resolve(key as Buffer),
    );
  });
}

function parsePasswordHash(value: string | undefined): ParsedPasswordHash | null {
  if (!value) return null;
  const parts = value.split("$");
  if (
    parts.length !== 6 ||
    parts[0] !== "scrypt" ||
    parts[1] !== String(PASSWORD_SCRYPT_N) ||
    parts[2] !== String(PASSWORD_SCRYPT_R) ||
    parts[3] !== String(PASSWORD_SCRYPT_P) ||
    !/^[A-Za-z0-9_-]+$/.test(parts[4]!) ||
    !/^[A-Za-z0-9_-]+$/.test(parts[5]!)
  ) {
    return null;
  }
  const salt = Buffer.from(parts[4]!, "base64url");
  const key = Buffer.from(parts[5]!, "base64url");
  if (salt.length !== PASSWORD_SALT_BYTES || key.length !== PASSWORD_KEY_BYTES) return null;
  return { salt, key };
}

export async function hashPassword(password: string): Promise<string> {
  const byteLength = Buffer.byteLength(password, "utf8");
  if (byteLength < 12 || byteLength > 1024) {
    throw new Error("Use a password between 12 and 1024 UTF-8 bytes.");
  }
  const salt = randomBytes(PASSWORD_SALT_BYTES);
  const key = await derivePasswordKey(password, salt);
  return [
    "scrypt",
    PASSWORD_SCRYPT_N,
    PASSWORD_SCRYPT_R,
    PASSWORD_SCRYPT_P,
    salt.toString("base64url"),
    key.toString("base64url"),
  ].join("$");
}

function hashSessionId(sessionId: string): string {
  return createHash("sha256").update(sessionId).digest("hex");
}

function cookieValue(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined;
  for (const segment of header.split(";")) {
    const separator = segment.indexOf("=");
    if (separator < 0 || segment.slice(0, separator).trim() !== name) continue;
    return segment.slice(separator + 1).trim();
  }
  return undefined;
}

function errorResponse(code: string, message: string) {
  return { error: { code, message } };
}

export class AuthManager {
  private readonly passwordHash: ParsedPasswordHash | null;
  private readonly sessionSecret: Buffer | null;
  private readonly sessions = new Map<string, AuthenticatedSession>();
  private readonly failuresByIp = new Map<string, LoginWindow>();
  private globalFailures: LoginWindow = { failures: 0, resetsAt: 0 };
  private concurrentPasswordChecks = 0;

  constructor(private readonly configuration: AuthConfiguration) {
    this.passwordHash = parsePasswordHash(configuration.passwordHash);
    const secret = configuration.sessionSecret?.trim();
    this.sessionSecret = secret && Buffer.byteLength(secret, "utf8") >= 32
      ? Buffer.from(secret, "utf8")
      : null;
  }

  get configured(): boolean {
    return this.passwordHash !== null && this.sessionSecret !== null;
  }

  async verifyPassword(password: string): Promise<boolean> {
    if (!this.configured || !this.passwordHash) return false;
    const actual = await derivePasswordKey(password, this.passwordHash.salt);
    return timingSafeEqual(actual, this.passwordHash.key);
  }

  beginPasswordCheck(): boolean {
    if (this.concurrentPasswordChecks >= MAX_CONCURRENT_PASSWORD_CHECKS) return false;
    this.concurrentPasswordChecks += 1;
    return true;
  }

  endPasswordCheck(): void {
    this.concurrentPasswordChecks = Math.max(0, this.concurrentPasswordChecks - 1);
  }

  loginRetryAfterSeconds(ip: string): number | null {
    const now = Date.now();
    this.pruneLoginWindows(now);
    const ipWindow = this.failuresByIp.get(ip);
    const blockedUntil = Math.max(
      ipWindow && ipWindow.failures >= MAX_FAILURES_PER_IP ? ipWindow.resetsAt : 0,
      this.globalFailures.failures >= MAX_GLOBAL_FAILURES ? this.globalFailures.resetsAt : 0,
    );
    return blockedUntil > now ? Math.ceil((blockedUntil - now) / 1000) : null;
  }

  recordLoginFailure(ip: string): void {
    const now = Date.now();
    this.pruneLoginWindows(now);
    const ipWindow = this.failuresByIp.get(ip) ?? { failures: 0, resetsAt: now + LOGIN_WINDOW_MS };
    ipWindow.failures += 1;
    this.failuresByIp.set(ip, ipWindow);
    if (this.globalFailures.resetsAt <= now) {
      this.globalFailures = { failures: 0, resetsAt: now + LOGIN_WINDOW_MS };
    }
    this.globalFailures.failures += 1;

    while (this.failuresByIp.size > MAX_RATE_LIMIT_KEYS) {
      const oldest = this.failuresByIp.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.failuresByIp.delete(oldest);
    }
  }

  recordLoginSuccess(ip: string): void {
    this.failuresByIp.delete(ip);
  }

  createSession(): { cookie: string; csrfToken: string; expiresAt: number } | null {
    if (!this.configured || !this.sessionSecret) return null;
    this.pruneSessions();
    if (this.sessions.size >= MAX_SESSIONS) return null;

    const sessionId = randomBytes(32).toString("base64url");
    const key = hashSessionId(sessionId);
    const csrfToken = randomBytes(32).toString("base64url");
    const expiresAt = Date.now() + SESSION_TTL_MS;
    this.sessions.set(key, { key, csrfToken, expiresAt });
    const signature = createHmac("sha256", this.sessionSecret)
      .update(sessionId)
      .digest("base64url");
    return { cookie: `${sessionId}.${signature}`, csrfToken, expiresAt };
  }

  getSession(cookieHeader: string | undefined): AuthenticatedSession | null {
    if (!this.configured || !this.sessionSecret) return null;
    const value = cookieValue(cookieHeader, COOKIE_NAME);
    const [sessionId, signature, extra] = value?.split(".") ?? [];
    if (
      extra !== undefined ||
      !sessionId ||
      !signature ||
      !/^[A-Za-z0-9_-]{43}$/.test(sessionId) ||
      !/^[A-Za-z0-9_-]{43}$/.test(signature)
    ) {
      return null;
    }
    const actualSignature = Buffer.from(signature, "base64url");
    const expectedSignature = createHmac("sha256", this.sessionSecret)
      .update(sessionId)
      .digest();
    if (
      actualSignature.length !== expectedSignature.length ||
      !timingSafeEqual(actualSignature, expectedSignature)
    ) {
      return null;
    }

    const key = hashSessionId(sessionId);
    const session = this.sessions.get(key);
    if (!session) return null;
    if (session.expiresAt <= Date.now()) {
      this.sessions.delete(key);
      return null;
    }
    return session;
  }

  isCsrfValid(
    session: AuthenticatedSession,
    suppliedHeader: string | undefined,
    suppliedCookie: string | undefined,
  ): boolean {
    if (
      !suppliedHeader ||
      !suppliedCookie ||
      suppliedHeader.length !== session.csrfToken.length ||
      suppliedCookie.length !== session.csrfToken.length
    ) {
      return false;
    }
    const expected = Buffer.from(session.csrfToken);
    return timingSafeEqual(Buffer.from(suppliedHeader), expected) &&
      timingSafeEqual(Buffer.from(suppliedCookie), expected);
  }

  revokeSession(cookieHeader: string | undefined): void {
    const session = this.getSession(cookieHeader);
    if (session) this.sessions.delete(session.key);
  }

  setCookie(value: string, maxAgeSeconds = Math.floor(SESSION_TTL_MS / 1000)): string {
    return `${COOKIE_NAME}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAgeSeconds}${this.configuration.cookieSecure ? "; Secure" : ""}`;
  }

  setCsrfCookie(value: string, maxAgeSeconds = Math.floor(SESSION_TTL_MS / 1000)): string {
    return `kudu_csrf=${value}; Path=/; SameSite=Strict; Max-Age=${maxAgeSeconds}${this.configuration.cookieSecure ? "; Secure" : ""}`;
  }

  clearCookies(): string[] {
    const secure = this.configuration.cookieSecure ? "; Secure" : "";
    const expiry = "; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT";
    return [
      `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Strict${expiry}${secure}`,
      `kudu_csrf=; Path=/; SameSite=Strict${expiry}${secure}`,
    ];
  }

  private pruneSessions(): void {
    const now = Date.now();
    for (const [key, session] of this.sessions) {
      if (session.expiresAt <= now) this.sessions.delete(key);
    }
  }

  private pruneLoginWindows(now: number): void {
    for (const [ip, window] of this.failuresByIp) {
      if (window.resetsAt <= now) this.failuresByIp.delete(ip);
    }
    if (this.globalFailures.resetsAt <= now) {
      this.globalFailures = { failures: 0, resetsAt: 0 };
    }
  }
}

function isLoopback(value: string): boolean {
  const host = value.toLowerCase().replace(/^\[|\]$/g, "");
  if (host.startsWith("::ffff:")) return isLoopback(host.slice("::ffff:".length));
  return host === "localhost" || host === "::1" || /^127(?:\.\d{1,3}){3}$/.test(host);
}

function sameLocalOrigin(originHeader: string | undefined, requestHost: string): boolean {
  if (!originHeader) return false;
  try {
    const origin = new URL(originHeader);
    const host = new URL(`http://${requestHost}`);
    if (origin.protocol !== "http:" || !isLoopback(origin.hostname) || !isLoopback(host.hostname)) return false;
    const configuredApiPort = process.env.PORT?.trim() || "3000";
    if (origin.hostname.toLowerCase() !== host.hostname.toLowerCase() &&
        !isLoopback(origin.hostname)) return false;
    if (origin.port === host.port) return true;
    return host.port === configuredApiPort && origin.port === "5173";
  } catch {
    return false;
  }
}

export function registerAuthenticationGuard(
  app: FastifyInstance,
  auth: AuthManager,
  options: { localMode?: boolean } = {},
): void {
  app.addHook("onRequest", async (request, reply) => {
    const path = request.url.split("?")[0] ?? request.url;
    if (path !== "/api/v1" && !path.startsWith("/api/v1/")) return;
    if (options.localMode) {
      const remoteAddress = request.socket.remoteAddress ?? "";
      const hostHeader = request.headers.host ?? "";
      let requestHostname = "";
      try {
        requestHostname = new URL(`http://${hostHeader}`).hostname;
      } catch {
        return reply.code(403).send(errorResponse("LOCAL_ONLY", "This local service accepts loopback requests only."));
      }
      if (!isLoopback(remoteAddress) || !isLoopback(requestHostname)) {
        return reply.code(403).send(errorResponse("LOCAL_ONLY", "This local service accepts loopback requests only."));
      }
      if (!["GET", "HEAD", "OPTIONS"].includes(request.method.toUpperCase())) {
        if (request.headers["sec-fetch-site"] === "cross-site" || !sameLocalOrigin(request.headers.origin, hostHeader)) {
          return reply.code(403).send(errorResponse("LOCAL_ORIGIN_REQUIRED", "This request must come from the local Kudu page."));
        }
      }
      return;
    }
    const method = request.method.toUpperCase();
    if (
      (path === "/api/v1/health" && (method === "GET" || method === "HEAD")) ||
      (path === "/api/v1/auth/session" && (method === "GET" || method === "HEAD")) ||
      (path === "/api/v1/auth/login" && method === "POST")
    ) {
      return;
    }

    reply.header("Cache-Control", "no-store");
    if (!auth.configured) {
      return reply.code(503).send(errorResponse(
        "AUTH_NOT_CONFIGURED",
        "Authentication is not configured for this service.",
      ));
    }
    const session = auth.getSession(request.headers.cookie);
    if (!session) {
      return reply.code(401).send(errorResponse("AUTH_REQUIRED", "Sign in to access this resource."));
    }
    const csrfHeader = request.headers["x-kudu-csrf"];
    const csrfCookie = cookieValue(request.headers.cookie, "kudu_csrf");
    if (typeof csrfHeader !== "string" || !auth.isCsrfValid(session, csrfHeader, csrfCookie)) {
      return reply.code(403).send(errorResponse("CSRF_INVALID", "The session security token is invalid."));
    }
  });
}

export function registerAuthRoutes(
  app: FastifyInstance,
  auth: AuthManager,
  options: { localMode?: boolean } = {},
): void {
  app.get("/api/v1/auth/session", async (request, reply) => {
    reply.header("Cache-Control", "no-store");
    if (options.localMode) {
      return { configured: true, authenticated: true, localMode: true };
    }
    const session = auth.getSession(request.headers.cookie);
    if (session) reply.header("Set-Cookie", auth.setCsrfCookie(session.csrfToken));
    return {
      configured: auth.configured,
      authenticated: Boolean(session),
      ...(session ? { expiresAt: new Date(session.expiresAt).toISOString() } : {}),
    };
  });

  app.post<{ Body: unknown }>("/api/v1/auth/login", async (request, reply) => {
    reply.header("Cache-Control", "no-store");
    if (!auth.configured) {
      return reply.code(503).send(errorResponse(
        "AUTH_NOT_CONFIGURED",
        "Authentication is not configured for this service.",
      ));
    }
    const body = request.body;
    const password = typeof body === "object" && body !== null && "password" in body
      ? (body as { password?: unknown }).password
      : undefined;
    if (typeof password !== "string" || Buffer.byteLength(password, "utf8") < 1 || Buffer.byteLength(password, "utf8") > 1024) {
      return reply.code(400).send(errorResponse("INVALID_REQUEST", "Enter a valid password."));
    }

    const retryAfter = auth.loginRetryAfterSeconds(request.ip);
    if (retryAfter !== null) {
      reply.header("Retry-After", String(retryAfter));
      return reply.code(429).send(errorResponse("LOGIN_RATE_LIMITED", "Too many sign-in attempts. Try again later."));
    }
    if (!auth.beginPasswordCheck()) {
      reply.header("Retry-After", "5");
      return reply.code(429).send(errorResponse("LOGIN_BUSY", "Sign-in is busy. Try again shortly."));
    }
    let valid: boolean;
    try {
      valid = await auth.verifyPassword(password);
    } finally {
      auth.endPasswordCheck();
    }
    if (!valid) {
      auth.recordLoginFailure(request.ip);
      return reply.code(401).send(errorResponse("INVALID_CREDENTIALS", "The password is incorrect."));
    }

    auth.recordLoginSuccess(request.ip);
    const session = auth.createSession();
    if (!session) {
      return reply.code(503).send(errorResponse("SESSION_CAPACITY_REACHED", "No session capacity is available."));
    }
    reply.header("Set-Cookie", [
      auth.setCookie(session.cookie),
      auth.setCsrfCookie(session.csrfToken),
    ]);
    return {
      configured: true,
      authenticated: true,
      expiresAt: new Date(session.expiresAt).toISOString(),
    };
  });

  app.post("/api/v1/auth/logout", async (request, reply) => {
    auth.revokeSession(request.headers.cookie);
    reply.header("Cache-Control", "no-store");
    reply.header("Set-Cookie", auth.clearCookies());
    return reply.code(204).send();
  });
}
