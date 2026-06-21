import "dotenv/config";
import express from "express";
import cors from "cors";
import { paymentMiddleware, setSettlementOverrides, x402ResourceServer } from "@x402/express";
import { HTTPFacilitatorClient } from "@x402/core/server";
import { ExactEvmScheme } from "@x402/evm/exact/server";
import { UptoEvmScheme } from "@x402/evm/upto/server";
import { BatchSettlementEvmScheme } from "@x402/evm/batch-settlement/server";

const PORT = Number(process.env.PORT) || 4021;
const PAY_TO = process.env.PAY_TO_ADDRESS;
const FACILITATOR_URL = process.env.FACILITATOR_URL || "https://x402.org/facilitator";
const CLIENT_ORIGIN = process.env.CLIENT_ORIGIN || "http://localhost:5173";

// x402 v2 uses CAIP-2 network identifiers. eip155:84532 == Base Sepolia testnet.
const NETWORK = "eip155:84532";

if (!PAY_TO) {
  console.warn(
    "\n⚠️  PAY_TO_ADDRESS is not set. Copy server/.env.example to server/.env and add your wallet address.\n"
  );
}

const app = express();
app.use(express.json());

// The browser needs to read the PAYMENT-REQUIRED / PAYMENT-RESPONSE headers,
// so they must be explicitly exposed via CORS.
app.use(
  cors({
    origin: CLIENT_ORIGIN,
    exposedHeaders: ["PAYMENT-REQUIRED", "PAYMENT-RESPONSE", "WWW-Authenticate"],
  })
);

// The facilitator verifies signatures and settles payments on-chain so this
// server never has to touch gas, RPC nodes, or private keys itself.
const facilitatorClient = new HTTPFacilitatorClient({ url: FACILITATOR_URL });

// The resource server is where you register which payment scheme(s) you
// accept per network. A network can have more than one scheme registered —
// the route config below picks which scheme each individual route uses.
const resourceServer = new x402ResourceServer(facilitatorClient)
  .register(NETWORK, new ExactEvmScheme()) // fixed price per request
  .register(NETWORK, new UptoEvmScheme()) // client authorizes a max, server settles actual usage
  .register(NETWORK, new BatchSettlementEvmScheme()); // escrow + off-chain vouchers, redeemed in batches

// --- Free route ---------------------------------------------------------
app.get("/api/health", (_req, res) => {
  res.json({ status: "ok", network: NETWORK, payTo: PAY_TO ?? null });
});

// --- Paid routes -----------------------------------------------------------
// Anything matched here returns 402 with payment instructions until a valid
// PAYMENT-SIGNATURE header is attached, at which point the middleware
// verifies + settles the payment and lets the request through.
app.use(
  paymentMiddleware(
    {
      // exact: fixed price, paid in full every call.
      "GET /api/quote": {
        accepts: {
          scheme: "exact",
          price: "$0.001",
          network: NETWORK,
          payTo: PAY_TO,
        },
        description: "A single random market quote",
        mimeType: "application/json",
      },

      // upto: client authorizes a maximum, server settles only what it used.
      "GET /api/generate": {
        accepts: {
          scheme: "upto",
          price: "$0.05", // maximum the client authorizes
          network: NETWORK,
          payTo: PAY_TO,
        },
        description: "AI text generation — billed by tokens actually generated",
        mimeType: "application/json",
      },

      // batch-settlement: client funds an escrow channel once, pays with
      // off-chain vouchers, and this server redeems many calls in one
      // on-chain transaction instead of settling every request individually.
      "GET /api/tick": {
        accepts: {
          scheme: "batch-settlement",
          price: "$0.0005", // per-request maximum, same idea as `upto`
          network: NETWORK,
          payTo: PAY_TO,
        },
        description: "One metered tick, redeemed later as part of a batch",
        mimeType: "application/json",
      },
    },
    resourceServer
  )
);

const QUOTES = [
  "Buy low, sell high — easier said than done.",
  "The trend is your friend, until it ends.",
  "Time in the market beats timing the market.",
  "Markets can stay irrational longer than you can stay solvent.",
  "The four most dangerous words: this time it's different.",
];

app.get("/api/quote", (_req, res) => {
  const quote = QUOTES[Math.floor(Math.random() * QUOTES.length)];
  res.json({ quote, paidAt: new Date().toISOString() });
});

app.get("/api/generate", (_req, res) => {
  // Simulate variable-cost work (LLM tokens, compute time, etc.) and only
  // charge for what was actually used — never more than the $0.05 max above.
  const maxAmountAtomic = 50_000; // $0.05 in 6-decimal USDC atomic units
  const actualUsage = Math.floor(Math.random() * (maxAmountAtomic + 1));
  const tokens = Math.floor(actualUsage / 50) + 10;

  setSettlementOverrides(res, { amount: String(actualUsage) });

  res.json({
    result: `Here is your generated text (${tokens} tokens)...`,
    usage: {
      authorizedMaxAtomic: String(maxAmountAtomic),
      actualChargedAtomic: String(actualUsage),
      tokens,
    },
  });
});

app.get("/api/tick", (_req, res) => {
  // batch-settlement also supports setSettlementOverrides if you want to
  // meter usage per call — here we just take the full per-tick maximum.
  res.json({ tick: Date.now(), note: "Settled later, batched with other ticks from this channel." });
});

app.listen(PORT, () => {
  console.log(`💸 x402 resource server listening on http://localhost:${PORT}`);
  console.log(`   Free:   GET /api/health`);
  console.log(`   exact:  GET /api/quote     ($0.001 fixed, on ${NETWORK})`);
  console.log(`   upto:   GET /api/generate  (up to $0.05, settled by usage)`);
  console.log(`   batch:  GET /api/tick      (up to $0.0005, redeemed in batches)`);
  console.log(`   Facilitator: ${FACILITATOR_URL}`);
});
