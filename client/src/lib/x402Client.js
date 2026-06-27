import {x402Client, x402HTTPClient} from "@x402/core/client";
import {ExactEvmScheme} from "@x402/evm/exact/client";
import {UptoEvmScheme} from "@x402/evm/upto/client";
import {wrapFetchWithPayment} from "@x402/fetch";
import {ExactSvmScheme} from "@x402/svm/exact/client";

const EVM_NETWORK = "eip155:8453";
const SOLANA_MAINNET = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp";

/**
 * Builds a payment-aware fetch function.
 *
 * Pass either `evmSigner` (EVM wallet via viem) or `svmSigner` (Solana wallet via toSolanaSigner).
 * Only the relevant network's scheme is registered,
 * so the client automatically selects the right payment option from the server's 402 response.
 */
export function createPaymentFetch({walletClient, address, svmSigner, onEvent}) {
    const client = new x402Client();

    if (walletClient && address) {
        // EVM: exact + upto — both use EIP-712 off-chain signatures, no gas.
        const evmSigner = {
            address,
            signTypedData: (message) => walletClient.signTypedData({
                account: address,
                domain: message.domain,
                types: message.types,
                primaryType: message.primaryType,
                message: message.message
            })
        };

        client
            .register(EVM_NETWORK, new ExactEvmScheme(evmSigner))
            .register(EVM_NETWORK, new UptoEvmScheme(evmSigner));
    }

    if (svmSigner) {
        // SVM: exact — builds a Solana transfer tx, signed by the user's wallet.
        const rpcUrl = import.meta.env.VITE_SOLANA_RPC || "https://solana-rpc.publicnode.com";

        client.register(SOLANA_MAINNET, new ExactSvmScheme(svmSigner, {rpcUrl}));
    }

    client
        .onBeforePaymentCreation(async (ctx) => {
            onEvent?.({
                type: "payment-required",
                requirements: ctx.selectedRequirements
            });
        })
        .onAfterPaymentCreation(async (ctx) => {
            onEvent?.({
                type: "payment-signed",
                payload: ctx.paymentPayload
            });
        })
        .onPaymentCreationFailure(async (ctx) => {
            onEvent?.({
                type: "payment-failed",
                error: ctx.error
            });
        });

    const httpClient = new x402HTTPClient(client);
    const fetchWithPayment = wrapFetchWithPayment(fetch, client);

    return {
        fetchWithPayment,
        httpClient
    };
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