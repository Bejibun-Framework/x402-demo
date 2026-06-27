import react from "@vitejs/plugin-react";
import {defineConfig} from "vite";
import {nodePolyfills} from "vite-plugin-node-polyfills";

// @solana/web3.js, wagmi-style WalletConnect, and wallet-adapter deps all
// expect Buffer/process/global in the browser. Polyfill them here.
export default defineConfig({
    plugins: [
        react(),
        nodePolyfills({
            globals: {
                Buffer: true,
                global: true,
                process: true
            }
        })
    ],
    base: "/x402-playground",
    server: {
        port: 5173,
    },
    // Some WalletConnect deps ship broken .map files; suppress sourcemap noise.
    optimizeDeps: {
        esbuildOptions: {
            sourcemap: false
        }
    }
});