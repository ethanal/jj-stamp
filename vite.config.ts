import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  worker: { format: "es" },
  build: { outDir: "dist/client" },
  server: { host: "127.0.0.1" },
});
