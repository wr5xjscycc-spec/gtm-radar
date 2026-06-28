import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Dev server for the live board. Run alongside `npm run dev:convex`.
export default defineConfig({
  plugins: [react()],
});
