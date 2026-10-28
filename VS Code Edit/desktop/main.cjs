"use strict";

const path = require("node:path");
const { app, BrowserWindow, dialog, ipcMain, session, shell } = require("electron");
const {
  isSameOrigin,
  isSandboxDisabledByArgs,
  parseServerUrl,
  validatedExternalUrl,
} = require("./connection-policy.cjs");

const REMOTE_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "frame-src 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join("; ");

let connectionWindow = null;
let serverWindow = null;
let activeServerOrigin = null;

function rendererFile() {
  return app.isPackaged
    ? path.join(process.resourcesPath, "renderer", "desktop.html")
    : path.resolve(__dirname, "../frontend/dist-desktop/desktop.html");
}

function installServerContentPolicy(serverSession) {
  serverSession.webRequest.onHeadersReceived(
    { urls: ["http://*/*", "https://*/*"] },
    (details, callback) => {
      if (details.resourceType !== "mainFrame" || !isSameOrigin(details.url, activeServerOrigin)) {
        callback({ responseHeaders: details.responseHeaders });
        return;
      }

      const responseHeaders = { ...details.responseHeaders };
      const headerName = Object.keys(responseHeaders)
        .find((name) => name.toLowerCase() === "content-security-policy")
        ?? "Content-Security-Policy";
      responseHeaders[headerName] = [
        ...(responseHeaders[headerName] ?? []),
        REMOTE_CSP,
      ];
      callback({ responseHeaders });
    },
  );
}

function createServerWindow(origin) {
  const serverSession = session.fromPartition("persist:kuduns-server");
  activeServerOrigin = origin;
  installServerContentPolicy(serverSession);

  const window = new BrowserWindow({
    width: 1440,
    height: 940,
    minWidth: 900,
    minHeight: 640,
    show: false,
    backgroundColor: "#f3f5f8",
    webPreferences: {
      session: serverSession,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      devTools: !app.isPackaged,
    },
  });

  const allowSelectedServer = (event, destination) => {
    if (!isSameOrigin(destination, origin)) event.preventDefault();
  };
  window.webContents.on("will-navigate", allowSelectedServer);
  window.webContents.on("will-redirect", allowSelectedServer);
  window.webContents.setWindowOpenHandler(({ url }) => {
    const external = validatedExternalUrl(url);
    if (external) void shell.openExternal(external).catch(() => {});
    return { action: "deny" };
  });
  window.once("ready-to-show", () => window.show());
  window.on("closed", () => {
    if (serverWindow === window) serverWindow = null;
  });
  return window;
}

function createConnectionWindow() {
  const window = new BrowserWindow({
    width: 900,
    height: 780,
    minWidth: 580,
    minHeight: 620,
    show: false,
    backgroundColor: "#10223e",
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      devTools: !app.isPackaged,
    },
  });

  const allowedFile = require("node:url").pathToFileURL(rendererFile()).toString();
  window.webContents.on("will-navigate", (event, destination) => {
    if (destination !== allowedFile) event.preventDefault();
  });
  window.webContents.on("will-redirect", (event, destination) => {
    if (destination !== allowedFile) event.preventDefault();
  });
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.once("ready-to-show", () => window.show());
  window.on("closed", () => {
    if (connectionWindow === window) connectionWindow = null;
  });
  void window.loadFile(rendererFile()).catch(() => {
    if (!window.isDestroyed()) window.close();
  });
  return window;
}

function registerConnectionIpc() {
  ipcMain.handle("desktop:local-mode-info", (event) => {
    if (!connectionWindow || event.sender !== connectionWindow.webContents) {
      return { enabled: false, message: "Local mode is unavailable in this build.", prerequisites: [] };
    }
    return {
      enabled: false,
      message: "Local mode is not ready. This build does not start, adopt, or stop a backend process.",
      prerequisites: [
        "PostgreSQL must be installed and managed separately.",
        "Backend database and authentication settings must be provisioned outside the desktop.",
        "A safe packaged backend process manager is not included in this milestone.",
      ],
    };
  });

  ipcMain.handle("desktop:connect-server", async (event, request) => {
    if (!connectionWindow || event.sender !== connectionWindow.webContents) {
      return { status: "error", message: "The connection request is not available." };
    }

    let server;
    try {
      server = parseServerUrl(request?.url, request?.allowInsecureHttp === true);
    } catch (error) {
      return {
        status: "error",
        message: error instanceof Error ? error.message : "Enter a valid KuduNS server address.",
      };
    }

    const confirmation = await dialog.showMessageBox(connectionWindow, {
      type: server.protocol === "http:" ? "warning" : "question",
      title: "Confirm KuduNS server",
      message: `Connect to ${server.origin}?`,
      detail: server.protocol === "http:"
        ? "This connection is not encrypted. Continue only for a trusted local or isolated LAN server."
        : "The desktop will contact this server and open its KuduNS sign-in page. Credentials are not saved by the desktop.",
      buttons: ["Cancel", "Connect"],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
    });
    if (confirmation.response !== 1) return { status: "cancelled" };

    try {
      const healthResponse = await fetch(new URL("/healthz", server.origin), {
        headers: { Accept: "application/json" },
        redirect: "error",
        signal: AbortSignal.timeout(8000),
      });
      if (!healthResponse.ok) throw new Error("health");
      const health = await healthResponse.json();
      if (health?.status !== "ok") throw new Error("health");
    } catch {
      return {
        status: "error",
        message: "Could not reach a KuduNS server at that address. Check the address and network, then try again.",
      };
    }

    let nextWindow;
    try {
      nextWindow = createServerWindow(server.origin);
      await nextWindow.loadURL(server.origin);
    } catch {
      if (nextWindow && !nextWindow.isDestroyed()) nextWindow.close();
      activeServerOrigin = null;
      return {
        status: "error",
        message: "The server responded, but its KuduNS application could not be opened.",
      };
    }

    serverWindow = nextWindow;
    serverWindow.show();
    if (connectionWindow && !connectionWindow.isDestroyed()) connectionWindow.close();
    connectionWindow = null;
    return { status: "connected" };
  });
}

app.whenReady().then(async () => {
  const runningAsRoot = process.platform === "linux"
    && typeof process.getuid === "function"
    && process.getuid() === 0;
  if (isSandboxDisabledByArgs(process.argv) || runningAsRoot) {
    await dialog.showMessageBox({
      type: "error",
      title: "KuduNS sandbox support is required",
      message: "KuduNS requires Electron's sandbox and an unprivileged desktop user.",
      detail: "Run as a regular user with unprivileged user namespaces enabled. The desktop will not bypass the sandbox requirement.",
    });
    app.quit();
    return;
  }

  registerConnectionIpc();
  connectionWindow = createConnectionWindow();
  app.on("activate", () => {
    if (!connectionWindow && !serverWindow) connectionWindow = createConnectionWindow();
  });
});

app.on("window-all-closed", () => {
  app.quit();
});
