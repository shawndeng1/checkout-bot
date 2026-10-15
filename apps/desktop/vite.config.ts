import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwind from "@tailwindcss/vite";
import path from "node:path";
export default defineConfig({
  root: path.resolve("apps/desktop"),
  base: "./",
  plugins: [
    react(),
    tailwind(),
    {
      name: "development-csp",
      apply: "serve",
      transformIndexHtml(html) {
        return html.replace(
          "script-src 'self'",
          "script-src 'self' 'unsafe-inline'",
        );
      },
    },
  ],
  server: { host: "127.0.0.1", port: 5173, strictPort: true },
  build: { outDir: "../../dist/renderer", emptyOutDir: true },
});
