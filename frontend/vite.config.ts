import { fileURLToPath } from 'node:url'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { defineConfig } from 'vite'

// status-page/lib.mjs is the single source of truth for Covenant's
// decision-decoding logic (already covered by test/status-page.live.ts
// against real chain state) - this app imports it directly rather than
// duplicating it, so nothing here can drift from what's tested there.
// server.fs.allow widens Vite's dev-server file access past `frontend/`
// to the repo root so that import can be served in dev.
// base './': assets resolve relative to the page, so the build works at a site
// root and under a sub-path (GitHub Pages serves a project at /<repo>/).
export default defineConfig({
  base: './',
  plugins: [react(), tailwindcss()],
  server: {
    fs: {
      allow: [fileURLToPath(new URL('..', import.meta.url))],
    },
  },
})
