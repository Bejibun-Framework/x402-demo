import {address as toAddress} from "@solana/kit";
import {WalletAdapterNetwork} from "@solana/wallet-adapter-base";
import {WalletConnectWalletAdapter} from "@solana/wallet-adapter-walletconnect";
import {VersionedTransaction, VersionedMessage, PublicKey} from "@solana/web3.js";
import {getWallets} from "@wallet-standard/app";

const SOLANA_MAINNET_CHAIN = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp";

// --- Phantom ----------------------------------------------------------------
export function getPhantom() {
    const p = window.phantom?.solana ?? (window.solana?.isPhantom ? window.solana : null);
    if (!p) throw new Error("Phantom wallet not found. Install the Phantom extension.");

    return p;
}

export async function connectPhantom() {
    const p = getPhantom();
    const res = await p.connect();

    return {
        provider: p,
        pubkey: res.publicKey.toBase58()
    };
}

// --- WalletConnect (Solana) -------------------------------------------------
export async function connectSolanaWalletConnect() {
    const adapter = new WalletConnectWalletAdapter({
        network: WalletAdapterNetwork.Mainnet,
        options: {
            projectId: import.meta.env.VITE_WC_PROJECT_ID,
            metadata: {
                name: "x402 Playground",
                description: "Bejibun x402 Playground",
                url: window.location.origin,
                icons: [],
            }
        }
    });

    await adapter.connect();

    if (!adapter.publicKey) throw new Error("WalletConnect connection failed.");

    return {
        provider: adapter,
        pubkey: adapter.publicKey.toBase58(),
        adapter
    };
}

// --- MetaMask (Wallet Standard / Solana) ------------------------------------
function findStandardWallet(name) {
    return getWallets()
        .get()
        .find((w) => w.name === name && w.features["solana:signTransaction"]);
}

export async function connectSolanaMetaMask() {
    const wallet = findStandardWallet("MetaMask");
    if (!wallet) {
        throw new Error("MetaMask Solana not found. Update MetaMask (extension v13.5+) and enable Solana.",);
    }

    const {accounts} = await wallet.features["standard:connect"].connect();
    const account = accounts.find((a) => a.chains?.includes(SOLANA_MAINNET_CHAIN)) ?? accounts[0];
    if (!account) throw new Error("MetaMask returned no Solana account.");

    const signFeature = wallet.features["solana:signTransaction"];
    const provider = {
        async signTransaction(vtx) {
            const [{signedTransaction}] = await signFeature.signTransaction({
                account,
                transaction: vtx.serialize(),
                chain: SOLANA_MAINNET_CHAIN
            });

            return VersionedTransaction.deserialize(signedTransaction);
        },
        disconnect: () => wallet.features["standard:disconnect"]?.disconnect?.()
    };

    return {
        provider,
        pubkey: account.address,
        adapter: {disconnect: provider.disconnect},
    };
}

// --- Signer bridge ----------------------------------------------------------
/**
 * Bridges any Phantom-shaped provider (Phantom, MetaMask SVM, WalletConnect)
 * into a @solana/kit TransactionPartialSigner for use with @x402/svm.
 */
export function toSolanaSigner(provider, pubkeyBase58) {
    const pubkey = new PublicKey(pubkeyBase58);
    const addr = toAddress(pubkeyBase58);

    return {
        address: addr,
        async signTransactions(transactions) {
            const results = [];

            for (const tx of transactions) {
                const inMsg = new Uint8Array(tx.messageBytes);
                const vtx = new VersionedTransaction(VersionedMessage.deserialize(inMsg));
                const signed = await provider.signTransaction(vtx);

                const keys = signed.message.staticAccountKeys;
                const idx = keys.findIndex((k) => k.equals(pubkey));
                const sig = idx >= 0 ? signed.signatures[idx] : null;

                const outMsg = signed.message.serialize();
                const msgUnchanged = outMsg.length === inMsg.length && outMsg.every((b, i) => b === inMsg[i]);
                const sigIsZero = !sig || sig.every((b) => b === 0);

                if (idx < 0) throw new Error("Wallet returned no key matching our address.");
                if (sigIsZero) throw new Error("Wallet returned an empty signature for our address.");
                if (!msgUnchanged) {
                    throw new Error("Wallet modified the transaction before signing. Try Phantom instead.",);
                }

                results.push({[addr]: new Uint8Array(sig)});
            }

            return results;
        }
    };
}