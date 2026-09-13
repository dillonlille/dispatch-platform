import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { fileURLToPath, URL } from "node:url";
export default defineConfig({
  publicDir: false,
  define: { "process.env.NODE_ENV": JSON.stringify("production") },
  plugins: [react(), tailwindcss()],
  resolve: {
    dedupe: ["react", "react-dom", "@tanstack/react-query", "lucide-react"],
    alias: { "@": fileURLToPath(new URL("./frontend/src", import.meta.url)) },
  },
  build: {
    outDir: "public/assets",
    emptyOutDir: false,
    lib: {
      entry: "frontend/src/main.tsx",
      name: "DispatchFrontend",
      formats: ["iife"],
      fileName: () => "frontend.js",
      cssFileName: "styles",
    },
  },
});
