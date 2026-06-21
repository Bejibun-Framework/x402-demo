import { useCallback, useState } from "react";
import { connectWallet } from "./lib/wallet.js";
import { createPaymentFetch, readSettlement, formatUsdc } from "./lib/x402Client.js";

const RESOURCE_URL = import.meta.env.VITE_RESOURCE_SERVER_URL || "http://localhost:4021";

// Two schemes are wired up to a one-click browser flow because both are pure
// off-chain signatures (no gas, no escrow funding tx needed from the buyer).
// `batch-settlement` needs an on-chain deposit into an escrow channel first —
// see scripts/batch-settlement-client.mjs for that one.
const ENDPOINTS = [
  {
    id: "exact",
    path: "/api/test/redis",
    title: "GET /api/test/redis",
    scheme: "exact",
    blurb: "Fixed price — every call costs exactly $0.001 USDC.",
    button: "Pay $0.001 & fetch quote",
  },
  {
    id: "upto",
    path: "/api/generate",
    title: "GET /api/generate",
    scheme: "upto",
    blurb: "Usage-based — you authorize up to $0.05, the server settles only what it actually used.",
    button: "Authorize up to $0.05 & generate",
  },
];

function shorten(value, lead = 6, tail = 4) {
  if (!value) return "";
  return value.length > lead + tail ? `${value.slice(0, lead)}…${value.slice(-tail)}` : value;
}

function humanizeError(err) {
  const message = err?.message ?? String(err);
  if (/user rejected|user denied/i.test(message)) {
    return "Signature request was cancelled in your wallet.";
  }
  if (/insufficient/i.test(message)) {
    return "Wallet doesn't have enough testnet USDC. Use the Circle faucet linked below.";
  }
  return message;
}

const CHIP_STYLES = {
  request: { label: "→", className: "chip chip--neutral" },
  "status-402": { label: "402", className: "chip chip--amber" },
  wallet: { label: "✎", className: "chip chip--neutral" },
  signed: { label: "✓", className: "chip chip--green" },
  "status-200": { label: "200", className: "chip chip--green" },
  settled: { label: "⛓", className: "chip chip--green" },
  error: { label: "✕", className: "chip chip--red" },
};

function LogLine({ entry }) {
  const style = CHIP_STYLES[entry.kind] ?? CHIP_STYLES.request;
  return (
    <div className="log-line">
      <span className={style.className}>{style.label}</span>
      <div className="log-line__body">
        <div className="log-line__text">{entry.text}</div>
        {entry.detail && <div className="log-line__detail">{entry.detail}</div>}
      </div>
    </div>
  );
}

function ResultCard({ endpointId, result }) {
  if (!result) return null;
  if (endpointId === "exact") {
    return (
      <div className="result">
        <div className="result__label">Quote received</div>
        <div className="result__quote">“{result.quote}”</div>
      </div>
    );
  }
  if (endpointId === "upto") {
    return (
      <div className="result">
        <div className="result__label">Generated — settled by usage</div>
        <div className="result__quote">{result.result}</div>
        <div className="result__meta">
          authorized max {formatUsdc(result.usage.authorizedMaxAtomic)} · charged{" "}
          {formatUsdc(result.usage.actualChargedAtomic)}
        </div>
      </div>
    );
  }
  return null;
}

export default function App() {
  const [wallet, setWallet] = useState(null);
  const [connecting, setConnecting] = useState(false);
  const [requestingId, setRequestingId] = useState(null);
  const [log, setLog] = useState([]);
  const [results, setResults] = useState({});
  const [settlement, setSettlement] = useState(null);
  const [error, setError] = useState(null);

  const handleConnect = useCallback(async () => {
    setConnecting(true);
    setError(null);
    try {
      const { walletClient, address } = await connectWallet();
      setWallet({ walletClient, address });
    } catch (err) {
      setError(humanizeError(err));
    } finally {
      setConnecting(false);
    }
  }, []);

  const handlePayAndFetch = useCallback(
    async (endpoint) => {
      if (!wallet) return;
      setRequestingId(endpoint.id);
      setError(null);
      setSettlement(null);

      const entries = [];
      const pushLog = (entry) => {
        entries.push({ id: entries.length, ...entry });
        setLog([...entries]);
      };

      const r = await fetch("http://localhost:3000/api/test/redis");
      console.log(r.headers.get("PAYMENT-REQUIRED"));
      console.log(r.headers.get("payment-required"));

      pushLog({ kind: "request", text: `GET ${endpoint.path}` });

      const { fetchWithPayment, httpClient } = createPaymentFetch({
        walletClient: wallet.walletClient,
        address: wallet.address,
        onEvent: (evt) => {
          if (evt.type === "payment-required") {
            const r = evt.requirements;
            pushLog({
              kind: "status-402",
              text: "402 Payment Required",
              detail: `${r.scheme} · ${r.network} · ${formatUsdc(r.amount) ?? r.amount} → ${shorten(r.payTo)}`,
            });
            pushLog({ kind: "wallet", text: "Requesting signature in wallet (EIP-712)…" });
          } else if (evt.type === "payment-signed") {
            pushLog({ kind: "signed", text: "Payment authorization signed" });
            pushLog({ kind: "request", text: `GET ${endpoint.path}  (+ PAYMENT-SIGNATURE header)` });
          } else if (evt.type === "payment-failed") {
            pushLog({ kind: "error", text: `Payment failed: ${humanizeError(evt.error)}` });
          }
        },
      });

      try {
        const response = await fetchWithPayment(`${RESOURCE_URL}${endpoint.path}`);

        if (!response.ok) {
          const text = await response.text().catch(() => "");
          throw new Error(text || `Request failed with status ${response.status}`);
        }

        pushLog({ kind: "status-200", text: "200 OK" });
        const data = await response.json();
        setResults((prev) => ({ ...prev, [endpoint.id]: data }));

        const settle = readSettlement(httpClient, response);
        if (settle) {
          setSettlement(settle);
          pushLog({
            kind: "settled",
            text:
              endpoint.scheme === "exact"
                ? "Payment settled on-chain"
                : "Payment settled on-chain (actual usage only)",
            detail: settle.transaction ? `tx ${shorten(settle.transaction)}` : "confirmed by facilitator",
          });
        }
      } catch (err) {
        const message = humanizeError(err);
        pushLog({ kind: "error", text: message });
        setError(message);
      } finally {
        setRequestingId(null);
      }
    },
    [wallet]
  );

  return (
    <div className="page">
      <header className="topbar">
        <div className="brand">
          <span className="brand__mark">402</span>
          <div>
            <div className="brand__title">x402 pay-per-request demo</div>
            <div className="brand__subtitle">Express · React · Base Sepolia</div>
          </div>
        </div>

        {wallet ? (
          <div className="wallet-pill">
            <span className="wallet-pill__dot" />
            {shorten(wallet.address)}
          </div>
        ) : (
          <button className="btn btn--ghost" onClick={handleConnect} disabled={connecting}>
            {connecting ? "Connecting…" : "Connect wallet"}
          </button>
        )}
      </header>

      <main className="layout">
        <section className="panel">
          <div className="panel__header">
            <span className="panel__eyebrow">Resources</span>
            <h2>Two payment schemes</h2>
            <p className="panel__desc">
              Same protocol, different settlement rules. Both are gasless, off-chain
              signatures from your wallet.
            </p>
          </div>

          {ENDPOINTS.map((endpoint) => (
            <div className="endpoint-card" key={endpoint.id}>
              <div className="endpoint-card__head">
                <span className={`scheme-tag scheme-tag--${endpoint.scheme}`}>{endpoint.scheme}</span>
                <span className="endpoint-card__title">{endpoint.title}</span>
              </div>
              <p className="endpoint-card__blurb">{endpoint.blurb}</p>
              <button
                className="btn btn--primary"
                onClick={() => handlePayAndFetch(endpoint)}
                disabled={!wallet || requestingId !== null}
              >
                {requestingId === endpoint.id ? "Processing…" : endpoint.button}
              </button>
              <ResultCard endpointId={endpoint.id} result={results[endpoint.id]} />
            </div>
          ))}

          {!wallet && <p className="hint">Connect a wallet first to send a payment.</p>}
          {error && <div className="error-banner">{error}</div>}

          <p className="hint hint--muted">
            Want the third scheme, <code>batch-settlement</code>? It funds an on-chain
            escrow channel first, so it's a Node script rather than a button — see{" "}
            <code>scripts/batch-settlement-client.mjs</code> in the project. Testnet funds:{" "}
            <a href="https://www.alchemy.com/faucets/base-sepolia" target="_blank" rel="noreferrer">
              Base Sepolia ETH
            </a>{" "}
            ·{" "}
            <a href="https://faucet.circle.com" target="_blank" rel="noreferrer">
              Circle USDC faucet
            </a>
            .
          </p>
        </section>

        <section className="panel panel--log">
          <div className="panel__header">
            <span className="panel__eyebrow">HTTP exchange</span>
            <h2>Live transcript</h2>
          </div>

          <div className="log">
            {log.length === 0 && <div className="log__empty">Nothing sent yet.</div>}
            {log.map((entry) => (
              <LogLine key={entry.id} entry={entry} />
            ))}
          </div>

          {settlement && (
            <div className="settlement">
              <div className="settlement__row">
                <span>status</span>
                <span>{settlement.success ? "settled" : "pending"}</span>
              </div>
              {settlement.transaction && (
                <div className="settlement__row">
                  <span>tx hash</span>
                  <a
                    href={`https://sepolia.basescan.org/tx/${settlement.transaction}`}
                    target="_blank"
                    rel="noreferrer"
                  >
                    {shorten(settlement.transaction, 10, 8)}
                  </a>
                </div>
              )}
            </div>
          )}
        </section>
      </main>
    </div>
  );
}
