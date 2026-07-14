import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { resolve } from "node:path";
import { defineConfig } from "vite";

const packageRoot = import.meta.dirname;

export default defineConfig({
  root: resolve(packageRoot, "ui"),
  base: "./",
  plugins: [react(), tailwindcss()],
  publicDir: false,
  envDir: false,
  envPrefix: "ROLL_UI_PUBLIC_",
  build: {
    outDir: resolve(packageRoot, "dist/ui-assets"),
    emptyOutDir: true,
    target: "es2022",
    sourcemap: false,
    cssCodeSplit: false,
    modulePreload: { polyfill: false },
    rollupOptions: {
      output: {
        entryFileNames: "assets/app.js",
        chunkFileNames: "assets/[name]-[hash].js",
        assetFileNames: (assetInfo) =>
          assetInfo.names.some((name) => name.endsWith(".css"))
            ? "assets/app.css"
            : "assets/[name]-[hash][extname]",
      },
    },
  },
});
