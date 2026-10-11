import { defineConfig } from "vite"
import react from "@vitejs/plugin-react"
import { viteSingleFile } from "vite-plugin-singlefile"

/**
 * The downloadable build: the whole app inlined into ONE index.html.
 * Browsers block ES-module scripts on file:// pages, so the GitHub-Releases
 * download ships as a single file that runs from a double-click — no
 * hosting, no server. Connects to the user's `opencode serve --cors null`.
 */
export default defineConfig({
  plugins: [react(), viteSingleFile()],
  build: { outDir: "dist-single", emptyOutDir: true },
})
