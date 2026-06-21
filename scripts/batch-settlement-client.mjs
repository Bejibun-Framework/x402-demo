// batch-settlement-client.mjs
//
// Demonstrates the x402 `batch-settlement` scheme against the demo server's
// GET /api/tick route.
//
// Unlike `exact` and `upto` (pure off-chain EIP-712 signatures), batch
// settlement needs the buyer to fund an on-chain escrow channel before the
// first request — that's a real transaction requiring gas, so it doesn't fit
// a one-click browser flow the same way. This is meant to run from a backend
// or an agent's own runtime, with its own funded key, which is why it's a
// script rather than a button in the React app.
//
// Run with:
//   cd scripts
//   cp .env.example .env   # fill in EVM_PRIVATE_KEY
//   npm install
//   npm start

import "dotenv/config";
import { createPublicClient, http } from "viem";
import { baseSepolia } from "viem/chains";
import { privateKeyToAccount } from "viem/accounts";
import { x402Client } from "@x402/core/client";
import { wrapFetchWithPayment } from "@x402/fetch";
import { toClientEvmSigner } from "@x402/evm";
import { BatchSettlementEvmScheme } from "@x402/evm/batch-settlement/client";

const NETWORK = "eip155:84532"; // Base Sepolia, same as server/index.js
const RESOURCE_SERVER_URL = process.env.RESOURCE_SERVER_URL || "http://localhost:4021";
const PRIVATE_KEY = process.env.EVM_PRIVATE_KEY;

if (!PRIVATE_KEY) {
  console.error("Set EVM_PRIVATE_KEY in scripts/.env first (see .env.example).");
  process.exit(1);
}

const account = privateKeyToAccount(PRIVATE_KEY);

// batch-settlement needs read access to the chain (to check escrow balance,
// build the funding transaction, etc.) — that's what the public client is for.
const publicClient = createPublicClient({ chain: baseSepolia, transport: http() });
const signer = toClientEvmSigner(account, publicClient);

const client = new x402Client().register(
  NETWORK,
  new BatchSettlementEvmScheme(signer, {
    // Fund the escrow channel up front for ~5 calls at the per-request max,
    // instead of topping it up on every single request.
    depositPolicy: { depositMultiplier: 5 },
  })
);

const fetchWithPayment = wrapFetchWithPayment(fetch, client);

async function main() {
  console.log(`Calling GET /api/tick five times from ${account.address}…`);
  console.log("First call funds the escrow channel (one on-chain tx); the rest just sign vouchers.\n");

  for (let i = 1; i <= 5; i++) {
    const start = Date.now();
    const response = await fetchWithPayment(`${RESOURCE_SERVER_URL}/api/tick`);
    const data = await response.json();
    console.log(`tick ${i}: ${JSON.stringify(data)}  (${Date.now() - start}ms)`);
  }

  console.log(
    "\nDone. The server settles all five ticks on-chain in one batched transaction later — not five separate ones."
  );
}

main().catch((err) => {
  console.error("\nFailed:", err.message ?? err);
  process.exit(1);
});
