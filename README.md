# x402 demo — Express + React, all three payment schemes (x402 protocol v2)

A working example of [x402](https://www.x402.org), the HTTP-native
micropayment protocol, covering all three payment schemes the protocol
currently defines:

| Scheme | What it means | How it's demoed here |
| --- | --- | --- |
| `exact` | Client pays a fixed, advertised price | React button → `GET /api/quote` ($0.001) |
| `upto` | Client authorizes a **maximum**; server settles **actual usage** | React button → `GET /api/generate` (up to $0.05) |
| `batch-settlement` | Client funds an escrow channel once, pays with off-chain vouchers; seller redeems many calls in one batched on-chain transaction | Node script → `GET /api/tick` ($0.0005/call) |

Built on the **current x402 v2 SDKs** (`@x402/express`, `@x402/core`,
`@x402/evm`, `@x402/fetch`) — not the deprecated `x402-express` v1 package.
Settlement runs on **Base Sepolia** (testnet) through the free public
facilitator at `https://x402.org/facilitator`, so nothing here costs real
money.

```
x402-demo/
├── server/    Express resource server (the seller) — all 3 schemes registered
├── client/    React + Vite app (the buyer) — exact + upto, one-click
└── scripts/   Standalone Node client for batch-settlement
```

## Why exact/upto are buttons but batch-settlement is a script

`exact` and `upto` are both **pure off-chain signatures** — EIP-712 typed
data, no gas, no transaction from the buyer. That maps cleanly onto "click a
button, sign a popup in MetaMask."

`batch-settlement` is different: before the first request, the buyer has to
**deposit funds into an on-chain escrow channel** (a real, gas-paying
transaction), then signs cheap off-chain vouchers against that balance for
subsequent calls. That funding step is the right shape for a backend or
agent process with its own key — not a wallet-popup click — so it's
demonstrated as a Node script in `scripts/` instead of a button in the UI.

## How the exact/upto flow works (React client)

1. The browser calls `GET /api/quote` or `GET /api/generate`.
2. `@x402/express`'s `paymentMiddleware` intercepts it, sees no payment
   attached, and responds `402 Payment Required` with a JSON body describing
   how to pay (scheme, network, amount, recipient).
3. `@x402/fetch`'s `wrapFetchWithPayment` catches that 402, asks the
   connected wallet to sign an EIP-712 payment authorization, and retries the
   request with a `PAYMENT-SIGNATURE` header.
4. The middleware sends that signature to the facilitator to verify and
   settle on-chain, then lets the request through to your route handler.
   For `/api/generate`, the handler calls `setSettlementOverrides()` first so
   only the actual usage is charged, never the full authorized max.
5. The response carries a `PAYMENT-RESPONSE` header with the settlement
   receipt (success flag, tx hash), which the client decodes and displays.

## 1. Run the server

```bash
cd server
cp .env.example .env
# edit .env and set PAY_TO_ADDRESS to a wallet you control
npm install
npm run dev
```

Starts on `http://localhost:4021` with all three routes registered:
`GET /api/quote` (exact), `GET /api/generate` (upto), `GET /api/tick`
(batch-settlement).

## 2. Run the client

```bash
cd client
cp .env.example .env   # defaults already point at localhost:4021
npm install
npm run dev
```

Open `http://localhost:5173`, click **Connect wallet** (any injected EVM
wallet such as MetaMask), then try either card — **Pay $0.001 & fetch
quote** (exact) or **Authorize up to $0.05 & generate** (upto). Both reuse
the same wallet connection and the same live HTTP transcript.

## 3. Try batch-settlement (optional, separate script)

```bash
cd scripts
cp .env.example .env   # set EVM_PRIVATE_KEY to a *testnet* key
npm install
npm start
```

This funds an escrow channel against `/api/tick` and calls it five times,
signing a cheap off-chain voucher each time instead of paying on-chain per
request.

> `batch-settlement` is a newer addition to x402 (launched mid-2026) — if you
> hit errors around missing escrow/channel contract addresses on Base
> Sepolia, check the [x402 docs](https://docs.x402.org) for the latest
> canonical contract addresses; testnet wiring for this scheme is still
> rolling out across facilitators.

## 4. Get testnet funds

Every flow above needs a little Base Sepolia ETH (gas for the wallet UI, or
for the escrow deposit in the batch-settlement script) and test USDC:

- Base Sepolia ETH: https://www.alchemy.com/faucets/base-sepolia
- Base Sepolia USDC: https://faucet.circle.com

## Notes on going to production

- Swap `https://x402.org/facilitator` for a production facilitator (e.g.
  Coinbase's CDP facilitator via `@coinbase/x402`) and switch the network to
  `eip155:8453` (Base mainnet).
- The public testnet facilitator is rate-limited and best-effort — don't
  point real traffic at it.
- `paymentMiddleware` accepts multiple `accepts` entries per route if you
  want to price the same endpoint in more than one currency/network/scheme.
- `setSettlementOverrides(res, { amount })` accepts raw atomic units, a
  percentage string (`"50%"`), or a dollar string (`"$0.05"`) — see
  `server/index.js` for the `upto` example.

## Package versions used

| package | version |
| --- | --- |
| `@x402/express` | ^2.3.0 |
| `@x402/core` | ^2.3.0 |
| `@x402/evm` | ^2.9.0 |
| `@x402/fetch` | ^2.1.0 |
| `viem` | ^2.21.0 |

`npm install` will pull the latest patch within these ranges.
