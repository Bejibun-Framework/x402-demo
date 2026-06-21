import { x402Client, x402HTTPClient } from "@x402/core/client";
import { ExactEvmScheme } from "@x402/evm/exact/client";
import { UptoEvmScheme } from "@x402/evm/upto/client";
import { wrapFetchWithPayment } from "@x402/fetch";

// Must match the network the server registered in server/index.js.
const NETWORK = "eip155:84532"; // Base Sepolia

/**
 * Builds a payment-aware fetch function bound to the connected wallet.
 *
 * `onEvent` is called at each step of the payment lifecycle so the UI can
 * render a live transcript of the protocol exchange (this is optional —
 * x402Client's hooks exist for logging/analytics/guardrails, not just demos).
 */
export function createPaymentFetch({ walletClient, address, onEvent }) {
  // x402's EVM scheme just needs an object that can produce an address and
  // sign EIP-712 typed data — any wallet client satisfies that shape.
  const signer = {
    address,
    signTypedData: (message) =>
      walletClient.signTypedData({
        account: address,
        domain: message.domain,
        types: message.types,
        primaryType: message.primaryType,
        message: message.message,
      }),
  };

  // Both `exact` and `upto` are pure off-chain signatures (EIP-712, no gas,
  // no on-chain transaction from the buyer) so the same signer covers both.
  // wrapFetchWithPayment reads the scheme out of the server's 402 response
  // and picks whichever registered scheme matches automatically.
  const client = new x402Client()
    .register(NETWORK, new ExactEvmScheme(signer))
    .register(NETWORK, new UptoEvmScheme(signer));

  client
    .onBeforePaymentCreation(async (ctx) => {
      onEvent?.({ type: "payment-required", requirements: ctx.selectedRequirements });
    })
    .onAfterPaymentCreation(async (ctx) => {
      onEvent?.({ type: "payment-signed", payload: ctx.paymentPayload });
    })
    .onPaymentCreationFailure(async (ctx) => {
      onEvent?.({ type: "payment-failed", error: ctx.error });
    });

  const httpClient = new x402HTTPClient(client);
  const fetchWithPayment = wrapFetchWithPayment(fetch, client);

  return { fetchWithPayment, httpClient };
}

/** Pulls the on-chain settlement receipt out of a successful response's headers. */
export function readSettlement(httpClient, response) {
  try {
    return httpClient.getPaymentSettleResponse((name) => response.headers.get(name));
  } catch {
    return null;
  }
}

/** Converts a USDC atomic amount (6 decimals) to a display string like "$0.001". */
export function formatUsdc(amount) {
  if (amount === undefined || amount === null) return null;
  const dollars = Number(amount) / 1_000_000;
  return `$${dollars.toFixed(dollars < 0.01 ? 4 : 2)}`;
}
