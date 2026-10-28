import { resolve } from "node:path";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig(({ mode }) => {
  const desktopBuild = mode === "desktop";
  return {
    base: desktopBuild ? "./" : "/",
    plugins: [react()],
    server: {
      proxy: {
        "/api": {
          target: "http://127.0.0.1:3000",
          changeOrigin: true,
        },
        "/healthz": {
          target: "http://127.0.0.1:3000",
          changeOrigin: true,
        },
      },
    },
    ...(desktopBuild
      ? {
          build: {
            outDir: "dist-desktop",
            emptyOutDir: true,
            rollupOptions: {
              input: {
                web: resolve("index.html"),
                desktop: resolve("desktop.html"),
              },
            },
          },
        }
      : {}),
  };
});
