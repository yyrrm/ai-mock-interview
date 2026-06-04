import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { fileURLToPath, URL } from "node:url";

// 빌드 결과는 dist/ 에 생성되고, Flask(web/server.py)가 이를 서빙한다.
export default defineConfig({
  base: "/",
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
  server: {
    port: 5173,
    // 개발 중에는 Flask(5500)로 API 요청을 프록시한다.
    proxy: {
      "/api": "http://localhost:5500",
    },
  },
});
