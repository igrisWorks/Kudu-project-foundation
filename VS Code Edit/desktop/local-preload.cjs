"use strict";
const { contextBridge, ipcRenderer } = require("electron");
contextBridge.exposeInMainWorld("kuduLocal", Object.freeze({
  revealDataDirectory: () => ipcRenderer.invoke("desktop:reveal-local-data"),
}));
