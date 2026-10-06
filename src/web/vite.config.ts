import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
	root: import.meta.dirname,
	plugins: [react(), tailwindcss()],
	build: { outDir: "../../dist/web", emptyOutDir: true },
	server: { proxy: { "/api": { target: "http://127.0.0.1:7310", ws: true } } },
});
