import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
export default defineConfig({
  plugins: [react()],
  server: { allowedHosts: ["ethan-antithesis.exe.xyz"], host: "0.0.0.0" },
});
