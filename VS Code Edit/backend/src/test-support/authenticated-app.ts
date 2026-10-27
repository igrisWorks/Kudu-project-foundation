import { randomBytes } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { createApp } from "../app.js";
import { hashPassword } from "../auth.js";

const testPassword = randomBytes(24).toString("base64url");
const testSessionSecret = randomBytes(48).toString("base64url");

type TestAppOptions = Omit<Parameters<typeof createApp>[0], "auth">;
type TestInjectOptions = {
  method?: string;
  url: string;
  payload?: string | Buffer | object;
  headers?: Record<string, string | string[]>;
};

export async function createAuthenticatedTestApp(
  options: TestAppOptions,
  registerTestRoutes?: (app: FastifyInstance) => void,
): Promise<FastifyInstance> {
  const passwordHash = await hashPassword(testPassword);
  const app = await createApp({
    ...options,
    auth: {
      passwordHash,
      sessionSecret: testSessionSecret,
      cookieSecure: false,
    },
  });

  registerTestRoutes?.(app);
  const rawInject = app.inject.bind(app);
  const login = await rawInject({
    method: "POST",
    url: "/api/v1/auth/login",
    payload: { password: testPassword },
  });
  if (login.statusCode !== 200) {
    throw new Error("Unable to establish an authenticated test session.");
  }
  const setCookie = login.headers["set-cookie"];
  const cookie = (Array.isArray(setCookie) ? setCookie : [setCookie])
    .filter((value): value is string => typeof value === "string")
    .map(value => value.split(";")[0])
    .join("; ");
  const csrfToken = cookie
    .split(";")
    .map(value => value.trim())
    .find(value => value.startsWith("kudu_csrf="))
    ?.slice("kudu_csrf=".length);
  if (!cookie || !csrfToken) throw new Error("Authentication test session was incomplete.");

  const authenticatedInject = (options: TestInjectOptions) => {
    return rawInject({
      ...options,
      headers: {
        ...options.headers,
        cookie: options.headers?.cookie ?? cookie,
        "x-kudu-csrf": options.headers?.["x-kudu-csrf"] ?? csrfToken,
      },
    });
  };
  Object.defineProperty(app, "inject", { value: authenticatedInject });
  return app;
}
