import {useCallback, useRef, useState} from "react";
import {connectWallet} from "./lib/wallet.js";
import {createPaymentFetch, readSettlement, formatUsdc} from "./lib/x402Client.js";
import logo from "./images/bejibun.png";

const RESOURCE_URL = import.meta.env.VITE_RESOURCE_SERVER_URL || "http://localhost:3000";

function shorten(value, lead = 6, tail = 4) {
    if (!value) return "";
    return value.length > lead + tail ? `${value.slice(0, lead)}…${value.slice(-tail)}` : value;
}

function humanizeError(err) {
    const message = err?.message ?? String(err);
    if (/user rejected|user denied/i.test(message)) return "Signature request was cancelled in your wallet.";
    if (/insufficient/i.test(message)) return "Wallet doesn't have enough testnet USDC. Use the Circle faucet linked below.";
    return message;
}

const CHIP_STYLES = {
    request: {label: "→", className: "chip chip--neutral"},
    "status-402": {label: "402", className: "chip chip--amber"},
    wallet: {label: "✎", className: "chip chip--neutral"},
    signed: {label: "✓", className: "chip chip--green"},
    "status-200": {label: "200", className: "chip chip--green"},
    settled: {label: "⛓", className: "chip chip--green"},
    error: {label: "✕", className: "chip chip--red"},
};

// Detect scheme from URL path
function detectSchemeFromPath(path) {
    const normalized = path.toLowerCase();
    if (normalized.includes("/api/generate")) return "upto";
    if (normalized.includes("/api/test")) return "exact";
    return null; // unknown, let server 402 tell us
}

function getSchemeLabel(scheme) {
    if (scheme === "exact") return {label: "EXACT", description: "Fixed price per call"};
    if (scheme === "upto") return {label: "UPTO", description: "Usage-based, settle actual amount"};
    return {label: "AUTO", description: "Scheme detected from server response"};
}

function LogLine({entry}) {
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

function OutputBlock({result, endpointScheme, copied, onCopy}) {
    if (!result) return null;

    let displayText;
    if (typeof result === "object") {
        if (result.result !== undefined) {
            // upto / generate
            displayText = result.result;
        } else {
            displayText = JSON.stringify(result, null, 2);
        }
    } else {
        displayText = String(result);
    }

    return (
        <div className="output-block">
            <div className="output-block__header">
                <span className="output-block__label">
                    {endpointScheme === "upto" ? "Generated — settled by usage" : "Response"}
                </span>
                {result.usage && (
                    <span className="output-block__meta">
                        authorized {formatUsdc(result.usage.authorizedMaxAtomic)} · charged {formatUsdc(result.usage.actualChargedAtomic)}
                    </span>
                )}
                <button className={`copy-btn${copied ? " copy-btn--copied" : ""}`} onClick={onCopy}>
                    {copied ? "✓ Copied" : "Copy"}
                </button>
            </div>
            <div className="output-block__scroll">
                <pre className="output-block__pre">{displayText}</pre>
            </div>
        </div>
    );
}

export default function App() {
    const [wallet, setWallet] = useState(null);
    const [connecting, setConnecting] = useState(false);
    const [urlInput, setUrlInput] = useState("/api/test");
    const [isRequesting, setIsRequesting] = useState(false);
    const [log, setLog] = useState([]);
    const [result, setResult] = useState(null);
    const [detectedScheme, setDetectedScheme] = useState(null);
    const [settlement, setSettlement] = useState(null);
    const [error, setError] = useState(null);
    const [copied, setCopied] = useState(false);

    const logRef = useRef(null);

    const handleConnect = useCallback(async () => {
        setConnecting(true);
        setError(null);
        try {
            const {walletClient, address} = await connectWallet();
            setWallet({walletClient, address});
        } catch (err) {
            setError(humanizeError(err));
        } finally {
            setConnecting(false);
        }
    }, []);

    const handleSend = useCallback(async () => {
        if (!wallet || !urlInput.trim()) return;

        const rawPath = urlInput.trim().startsWith("http") ? urlInput.trim() : urlInput.trim();
        const fullUrl = rawPath.startsWith("http") ? rawPath : `${RESOURCE_URL}${rawPath.startsWith("/") ? rawPath : "/" + rawPath}`;
        const path = rawPath.startsWith("http") ? new URL(rawPath).pathname : (rawPath.startsWith("/") ? rawPath : "/" + rawPath);

        const guessedScheme = detectSchemeFromPath(path);
        setDetectedScheme(guessedScheme);
        setIsRequesting(true);
        setError(null);
        setSettlement(null);
        setResult(null);
        setCopied(false);

        const entries = [];
        const pushLog = (entry) => {
            entries.push({id: entries.length, ...entry});
            setLog([...entries]);
            setTimeout(() => logRef.current?.scrollTo({top: logRef.current.scrollHeight, behavior: "smooth"}), 50);
        };

        pushLog({kind: "request", text: `GET ${path}`});

        const {fetchWithPayment, httpClient} = createPaymentFetch({
            walletClient: wallet.walletClient,
            address: wallet.address,
            onEvent: (evt) => {
                if (evt.type === "payment-required") {
                    const r = evt.requirements;
                    // Update detected scheme from actual server response
                    if (r.scheme) setDetectedScheme(r.scheme);
                    pushLog({
                        kind: "status-402",
                        text: "402 Payment Required",
                        detail: `${r.scheme} · ${r.network} · ${formatUsdc(r.amount) ?? r.amount} → ${shorten(r.payTo)}`,
                    });
                    pushLog({kind: "wallet", text: "Requesting signature in wallet (EIP-712)…"});
                } else if (evt.type === "payment-signed") {
                    pushLog({kind: "signed", text: "Payment authorization signed"});
                    pushLog({kind: "request", text: `GET ${path}  (+ PAYMENT-SIGNATURE header)`});
                } else if (evt.type === "payment-failed") {
                    pushLog({kind: "error", text: `Payment failed: ${humanizeError(evt.error)}`});
                }
            },
        });

        try {
            const response = await fetchWithPayment(fullUrl);
            if (!response.ok) {
                const text = await response.text().catch(() => "");
                throw new Error(text || `Request failed with status ${response.status}`);
            }

            pushLog({kind: "status-200", text: "200 OK"});
            const data = await response.json();
            setResult(data);

            const settle = readSettlement(httpClient, response);
            if (settle) {
                setSettlement(settle);
                const finalScheme = detectedScheme || guessedScheme;
                pushLog({
                    kind: "settled",
                    text: finalScheme === "exact" ? "Payment settled on-chain" : "Payment settled on-chain (actual usage only)",
                    detail: settle.transaction ? `tx ${shorten(settle.transaction)}` : "confirmed by facilitator",
                });
            }
        } catch (err) {
            const message = humanizeError(err);
            pushLog({kind: "error", text: message});
            setError(message);
        } finally {
            setIsRequesting(false);
        }
    }, [wallet, urlInput, detectedScheme]);

    const handleCopy = useCallback(() => {
        if (!result) return;
        const text = typeof result === "object" ? (result.result ?? JSON.stringify(result, null, 2)) : String(result);
        navigator.clipboard.writeText(text).then(() => {
            setCopied(true);
            setTimeout(() => setCopied(false), 2000);
        });
    }, [result]);

    const schemeInfo = getSchemeLabel(detectedScheme);

    return (
        <div className="page">
            <header className="topbar">
                <div className="brand">
                    <span className="brand__mark">
                        <img src={logo} alt="Bejibun" width={32}/>
                    </span>
                    <div>
                        <div className="brand__title">Bejibun x402 Playground</div>
                        <div className="brand__subtitle">A place for you play with x402 protocol</div>
                    </div>
                </div>
                {wallet ? (
                    <div className="wallet-pill">
                        <span className="wallet-pill__dot"/>
                        {shorten(wallet.address)}
                    </div>
                ) : (
                    <button className="btn btn--ghost" onClick={handleConnect} disabled={connecting}>
                        {connecting ? "Connecting…" : "Connect wallet"}
                    </button>
                )}
            </header>

            <main className="layout">
                {/* LEFT: Request panel */}
                <section className="panel">
                    <div className="panel__header">
                        <span className="panel__eyebrow">Resources</span>
                        <h2>Send a payment request</h2>
                        <p className="panel__desc">
                            Enter any x402-protected endpoint. The scheme is detected automatically from the server's
                            402 response — no manual selection needed.
                        </p>
                    </div>

                    <div className="request-card">
                        <div className="url-row">
                            <span className="url-method">GET</span>
                            <input
                                className="url-input"
                                type="text"
                                value={urlInput}
                                onChange={(e) => {
                                    setUrlInput(e.target.value);
                                    setDetectedScheme(detectSchemeFromPath(e.target.value));
                                }}
                                onKeyDown={(e) => e.key === "Enter" && wallet && !isRequesting && handleSend()}
                                placeholder="/api/test  or  https://..."
                                spellCheck={false}
                                autoComplete="off"
                            />
                        </div>

                        <div className="scheme-detector">
                            <span className={`scheme-tag scheme-tag--${detectedScheme || "auto"}`}>
                                {schemeInfo.label}
                            </span>
                            <span className="scheme-detector__desc">{schemeInfo.description}</span>
                        </div>

                        <div className="endpoint-hints">
                            <span className="hints-label">Try:</span>
                            {[
                                {path: "/api/test", scheme: "exact", note: "$0.001 fixed"},
                                {path: "/api/generate", scheme: "upto", note: "up to $0.05"},
                            ].map((h) => (
                                <button
                                    key={h.path}
                                    className="hint-chip"
                                    onClick={() => {
                                        setUrlInput(h.path);
                                        setDetectedScheme(h.scheme);
                                    }}
                                >
                                    <span className={`scheme-tag scheme-tag--${h.scheme}`}
                                          style={{fontSize: "9px", padding: "2px 5px"}}>{h.scheme}</span>
                                    {h.path}
                                    <span className="hint-chip__note">{h.note}</span>
                                </button>
                            ))}
                        </div>

                        <button
                            className="btn btn--primary send-btn"
                            onClick={handleSend}
                            disabled={!wallet || isRequesting || !urlInput.trim()}
                        >
                            {isRequesting ? "Processing…" : "Send request & pay"}
                        </button>

                        {!wallet && <p className="hint">Connect a wallet first to send a payment.</p>}
                        {error && <div className="error-banner">{error}</div>}
                    </div>

                    <OutputBlock
                        result={result}
                        endpointScheme={detectedScheme}
                        copied={copied}
                        onCopy={handleCopy}
                    />

                    {settlement && (
                        <div className="settlement">
                            <div className="settlement__row">
                                <span>status</span>
                                <span>{settlement.success ? "settled" : "pending"}</span>
                            </div>
                            {settlement.transaction && (
                                <div className="settlement__row">
                                    <span>tx hash</span>
                                    <a href={`https://sepolia.basescan.org/tx/${settlement.transaction}`}
                                       target="_blank" rel="noreferrer">
                                        {shorten(settlement.transaction, 10, 8)}
                                    </a>
                                </div>
                            )}
                        </div>
                    )}

                    <p className="hint hint--muted">
                        Want <code>batch-settlement</code>? It funds an on-chain escrow channel first —
                        see <code>scripts/batch-settlement-client.mjs</code>.{" "}
                        Testnet funds:{" "}
                        <a href="https://www.alchemy.com/faucets/base-sepolia" target="_blank" rel="noreferrer">Base
                            Sepolia ETH</a>
                        {" · "}
                        <a href="https://faucet.circle.com" target="_blank" rel="noreferrer">Circle USDC faucet</a>.
                    </p>
                </section>

                {/* RIGHT: Log panel */}
                <section className="panel panel--log">
                    <div className="panel__header">
                        <span className="panel__eyebrow">HTTP exchange</span>
                        <h2>Live transcript</h2>
                    </div>

                    <div className="log" ref={logRef}>
                        {log.length === 0 && <div className="log__empty">Nothing sent yet.</div>}
                        {log.map((entry) => (
                            <LogLine key={entry.id} entry={entry}/>
                        ))}
                    </div>
                </section>
            </main>
        </div>
    );
}