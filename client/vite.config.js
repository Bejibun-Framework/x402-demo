import react from "@vitejs/plugin-react";
import {defineConfig} from "vite";

export default defineConfig({
    plugins: [react()],
    base: "/x402-demo/",
    server: {
        port: 5173
    }
});
