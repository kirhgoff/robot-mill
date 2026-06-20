import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
	plugins: [react()],
	server: {
		host: "0.0.0.0",
		port: 3000,
		proxy: {
			"/api": {
				target: process.env.BACKEND_URL || "http://localhost:3100",
				changeOrigin: true,
				rewrite: (path) => path.replace(/^\/api/, ""),
			},
			"/ws": {
				target: process.env.BACKEND_URL?.replace("http", "ws") || "ws://localhost:3100",
				ws: true,
			},
		},
	},
});
