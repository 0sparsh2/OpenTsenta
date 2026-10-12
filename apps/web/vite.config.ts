import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

const api = process.env.FERRY_API ?? "http://localhost:8787";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    proxy: {
      "/api": { target: api, changeOrigin: true },
      "/traces": { target: api, changeOrigin: true },
      "/mock-ats": { target: api, changeOrigin: true },
      "/resume-fonts": { target: api, changeOrigin: true },
    },
  },
});
