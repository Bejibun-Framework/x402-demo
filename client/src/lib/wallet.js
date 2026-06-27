import {createWalletClient, custom} from "viem";
import {base} from "viem/chains";

/** Returns window.ethereum or throws a friendly error if no wallet is injected. */
function getInjectedProvider() {
    if (typeof window === "undefined" || !window.ethereum) {
        throw new Error("No EVM wallet found. Install MetaMask (or another injected wallet) and reload.");
    }

    return window.ethereum;
}

/**
 * Connects to the user's injected EVM wallet and switches to Base.
 * Returns a viem WalletClient plus the connected address.
 */
export async function connectEvmWallet() {
    const provider = getInjectedProvider();

    const walletClient = createWalletClient({
        chain: base,
        transport: custom(provider)
    });

    const [address] = await walletClient.requestAddresses();

    try {
        await walletClient.switchChain({id: base.id});
    } catch (err) {
        const code = err?.code ?? err?.cause?.code;
        if (code === 4902) {
            await provider.request({
                method: "wallet_addEthereumChain",
                params: [
                    {
                        chainId: base.id,
                        chainName: base.name,
                        nativeCurrency: base.nativeCurrency,
                        rpcUrls: base.rpcUrls,
                        blockExplorerUrls: base.blockExplorers
                    }
                ],
            });
        } else {
            throw err;
        }
    }

    return {walletClient, address};
}