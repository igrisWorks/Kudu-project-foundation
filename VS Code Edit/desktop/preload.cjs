"use strict";

const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("kuduDesktop", Object.freeze({
  connectServer: (request) => ipcRenderer.invoke("desktop:connect-server", {
    url: typeof request?.url === "string" ? request.url : "",
    allowInsecureHttp: request?.allowInsecureHttp === true,
  }),
  getLocalModeInfo: () => ipcRenderer.invoke("desktop:local-mode-info"),
  startLocal: () => ipcRenderer.invoke("desktop:start-local"),
}));
