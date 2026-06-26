import {useCallback, useRef, useState} from "react";
import {connectEvmWallet} from "./lib/wallet.js";
import {
    connectPhantom,
    connectSolanaMetaMask,
    connectSolanaWalletConnect,
    toSolanaSigner,
} from "./lib/solanaSigner.js";
import {createPaymentFetch, readSettlement, formatUsdc} from "./lib/x402Client.js";
import logo from "./images/bejibun.png";

const RESOURCE_URL = import.meta.env.VITE_RESOURCE_SERVER_URL || "http://localhost:4021";

const HTTP_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"];
const BODY_METHODS = ["POST", "PUT", "PATCH"];
const BODY_TYPES = ["json", "form-data", "x-www-form-urlencoded", "raw", "none"];

function shorten(value, lead = 6, tail = 4) {
    if (!value) return "";
    return value.length > lead + tail ? `${value.slice(0, lead)}…${value.slice(-tail)}` : value;
}

function humanizeError(err) {
    const message = err?.message ?? String(err);
    if (/user rejected|user denied/i.test(message)) return "Signature request was cancelled in your wallet.";
    if (/insufficient/i.test(message)) return "Wallet doesn't have enough USDC.";
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
        displayText = result.result !== undefined ? result.result : JSON.stringify(result, null, 2);
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
                        authorized {formatUsdc(result.usage.authorizedMaxAtomic)} · charged{" "}
                        {formatUsdc(result.usage.actualChargedAtomic)}
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

// Generic key-value editor (Params / Headers / Form fields)
function KeyValueEditor({rows, onChange, keyPlaceholder = "Key", valuePlaceholder = "Value", title}) {
    const addRow = () => onChange([...rows, {key: "", value: "", enabled: true}]);
    const removeRow = (i) => onChange(rows.filter((_, idx) => idx !== i));
    const updateRow = (i, field, val) => {
        const next = rows.map((p, idx) => (idx === i ? {...p, [field]: val} : p));
        onChange(next);
    };
    return (
        <div className="params-editor">
            <div className="params-editor__header">
                <span className="params-editor__title">{title}</span>
                <button className="params-add-btn" onClick={addRow}>+ Add</button>
            </div>
            {rows.length === 0 && (
                <div className="params-empty">No {title.toLowerCase()} yet. Click + Add to insert a row.</div>
            )}
            {rows.map((row, i) => (
                <div className="params-row" key={i}>
                    <input type="checkbox" className="params-check" checked={row.enabled}
                           onChange={(e) => updateRow(i, "enabled", e.target.checked)}/>
                    <input className="params-input" placeholder={keyPlaceholder} value={row.key}
                           onChange={(e) => updateRow(i, "key", e.target.value)}/>
                    <span className="params-eq">=</span>
                    <input className="params-input" placeholder={valuePlaceholder} value={row.value}
                           onChange={(e) => updateRow(i, "value", e.target.value)}/>
                    <button className="params-remove-btn" onClick={() => removeRow(i)}>✕</button>
                </div>
            ))}
        </div>
    );
}

// Body editor — JSON / form-data / urlencoded / raw / none
function BodyEditor({
                        bodyType,
                        onBodyTypeChange,
                        bodyJson,
                        onBodyJsonChange,
                        bodyFields,
                        onBodyFieldsChange,
                        bodyRaw,
                        onBodyRawChange
                    }) {
    return (
        <div className="body-editor">
            <div className="body-editor__header">
                <span className="params-editor__title">Body</span>
                <div className="body-type-tabs">
                    {BODY_TYPES.map((t) => (
                        <button
                            key={t}
                            className={`body-type-tab${bodyType === t ? " body-type-tab--active" : ""}`}
                            onClick={() => onBodyTypeChange(t)}
                        >
                            {t}
                        </button>
                    ))}
                </div>
            </div>

            {bodyType === "none" && (
                <div className="params-empty">This request has no body.</div>
            )}

            {bodyType === "json" && (
                <div className="body-raw-wrap">
                    <div className="body-raw-lang">JSON</div>
                    <textarea
                        className="body-textarea"
                        value={bodyJson}
                        onChange={(e) => onBodyJsonChange(e.target.value)}
                        placeholder={'{\n  "key": "value"\n}'}
                        spellCheck={false}
                    />
                </div>
            )}

            {bodyType === "raw" && (
                <div className="body-raw-wrap">
                    <div className="body-raw-lang">Text</div>
                    <textarea
                        className="body-textarea"
                        value={bodyRaw}
                        onChange={(e) => onBodyRawChange(e.target.value)}
                        placeholder="Raw body text…"
                        spellCheck={false}
                    />
                </div>
            )}

            {(bodyType === "form-data" || bodyType === "x-www-form-urlencoded") && (
                <KeyValueEditor
                    rows={bodyFields}
                    onChange={onBodyFieldsChange}
                    title={bodyType === "form-data" ? "Form Data" : "URL-Encoded Fields"}
                    keyPlaceholder="Field name"
                    valuePlaceholder="Value"
                />
            )}
        </div>
    );
}

function buildUrlWithParams(baseUrl, params) {
    const activeParams = params.filter((p) => p.enabled && p.key.trim());
    if (activeParams.length === 0) return baseUrl;
    try {
        const url = new URL(baseUrl);
        activeParams.forEach((p) => url.searchParams.set(p.key.trim(), p.value));
        return url.toString();
    } catch {
        const qs = activeParams
            .map((p) => `${encodeURIComponent(p.key.trim())}=${encodeURIComponent(p.value)}`)
            .join("&");
        return baseUrl.includes("?") ? `${baseUrl}&${qs}` : `${baseUrl}?${qs}`;
    }
}

function buildHeaders(headers) {
    const result = {};
    headers.filter((h) => h.enabled && h.key.trim()).forEach((h) => {
        result[h.key.trim()] = h.value;
    });
    return result;
}

function buildBody(bodyType, bodyJson, bodyFields, bodyRaw) {
    if (bodyType === "none") return {body: undefined, contentType: null};
    if (bodyType === "json") {
        const trimmed = bodyJson.trim();
        return trimmed
            ? {body: trimmed, contentType: "application/json"}
            : {body: undefined, contentType: null};
    }
    if (bodyType === "raw") {
        const trimmed = bodyRaw.trim();
        return trimmed
            ? {body: trimmed, contentType: "text/plain"}
            : {body: undefined, contentType: null};
    }
    if (bodyType === "form-data") {
        const fd = new FormData();
        bodyFields.filter((f) => f.enabled && f.key.trim()).forEach((f) => fd.append(f.key.trim(), f.value));
        return {body: fd, contentType: null}; // browser sets multipart boundary automatically
    }
    if (bodyType === "x-www-form-urlencoded") {
        const active = bodyFields.filter((f) => f.enabled && f.key.trim());
        if (active.length === 0) return {body: undefined, contentType: null};
        const encoded = active
            .map((f) => `${encodeURIComponent(f.key.trim())}=${encodeURIComponent(f.value)}`)
            .join("&");
        return {body: encoded, contentType: "application/x-www-form-urlencoded"};
    }
    return {body: undefined, contentType: null};
}

const SOL_LABELS = {phantom: "Phantom", metamask: "MetaMask", walletconnect: "WalletConnect"};

// Network toggle for navbar
function NavbarNetworkToggle({network, onChange}) {
    const isEvm = network === "evm";
    return (
        <div className="navbar-network-toggle">
            <button
                className={`navbar-net-btn${isEvm ? " navbar-net-btn--active" : ""}`}
                onClick={() => onChange("evm")}
            >
                EVM
            </button>
            <button
                className={`navbar-net-btn${!isEvm ? " navbar-net-btn--active" : ""}`}
                onClick={() => onChange("solana")}
            >
                Solana
            </button>
        </div>
    );
}

// Wallet connect area for navbar
function NavbarWalletConnect({
                                 network,
                                 evmWallet,
                                 solWallet,
                                 evmConnecting,
                                 solConnecting,
                                 onConnectEvm,
                                 onConnectSol,
                                 onDisconnectEvm,
                                 onDisconnectSol
                             }) {
    const [open, setOpen] = useState(false);
    const isEvm = network === "evm";

    if (isEvm) {
        if (evmWallet) {
            return (
                <div className="wallet-pill">
                    <span className="wallet-pill__dot"/>
                    {shorten(evmWallet.address)}
                    <button className="disconnect-btn" onClick={onDisconnectEvm}>Disconnect</button>
                </div>
            );
        }
        return (
            <button className="btn btn--ghost" onClick={onConnectEvm} disabled={evmConnecting}>
                {evmConnecting ? "Connecting…" : "Connect EVM wallet"}
            </button>
        );
    }

    // Solana
    if (solWallet) {
        return (
            <div className="wallet-pill">
                <span className="wallet-pill__dot"/>
                {shorten(solWallet.pubkey)} · {SOL_LABELS[solWallet.kind] ?? solWallet.kind}
                <button className="disconnect-btn" onClick={onDisconnectSol}>Disconnect</button>
            </div>
        );
    }

    return (
        <div style={{position: "relative", flex: "1 1 auto"}}>
            <button className="btn btn--ghost" style={{width: "100%"}} onClick={() => setOpen((v) => !v)}
                    disabled={solConnecting}>
                {solConnecting ? "Connecting…" : "Connect Solana wallet ▾"}
            </button>
            {open && (
                <div className="sol-dropdown">
                    {["phantom", "metamask", "walletconnect"].map((kind) => (
                        <button key={kind} className="sol-dropdown__item"
                                onClick={() => {
                                    onConnectSol(kind);
                                    setOpen(false);
                                }}>
                            {SOL_LABELS[kind]}
                        </button>
                    ))}
                </div>
            )}
        </div>
    );
}

export default function App() {
    const [network, setNetwork] = useState("evm");

    const [evmWallet, setEvmWallet] = useState(null);
    const [evmConnecting, setEvmConnecting] = useState(false);
    const [solWallet, setSolWallet] = useState(null);
    const [solConnecting, setSolConnecting] = useState(false);

    const [urlInput, setUrlInput] = useState(`${RESOURCE_URL}/api/quote`);
    const [method, setMethod] = useState("GET");
    const [params, setParams] = useState([]);
    const [headers, setHeaders] = useState([]);
    const [activeTab, setActiveTab] = useState("params");

    // Body state
    const [bodyType, setBodyType] = useState("none");
    const [bodyJson, setBodyJson] = useState("");
    const [bodyRaw, setBodyRaw] = useState("");
    const [bodyFields, setBodyFields] = useState([]);

    const [isRequesting, setIsRequesting] = useState(false);
    const [log, setLog] = useState([]);
    const [result, setResult] = useState(null);
    const [detectedScheme, setDetectedScheme] = useState(null);
    const [settlement, setSettlement] = useState(null);
    const [error, setError] = useState(null);
    const [copied, setCopied] = useState(false);

    const logRef = useRef(null);

    const handleNetworkChange = useCallback((net) => {
        setNetwork(net);
        setError(null);
    }, []);

    const handleConnectEvm = useCallback(async () => {
        setEvmConnecting(true);
        setError(null);
        try {
            const {walletClient, address} = await connectEvmWallet();
            setEvmWallet({walletClient, address});
        } catch (err) {
            setError(humanizeError(err));
        } finally {
            setEvmConnecting(false);
        }
    }, []);

    const handleConnectSol = useCallback(async (kind) => {
        setSolConnecting(true);
        setError(null);
        try {
            const connectors = {
                phantom: connectPhantom,
                metamask: connectSolanaMetaMask,
                walletconnect: connectSolanaWalletConnect,
            };
            const conn = await connectors[kind]();
            setSolWallet({...conn, kind});
        } catch (err) {
            setError(humanizeError(err));
        } finally {
            setSolConnecting(false);
        }
    }, []);

    const handleDisconnectSol = useCallback(async () => {
        try {
            await solWallet?.adapter?.disconnect?.();
        } catch { /* ignore */
        }
        setSolWallet(null);
    }, [solWallet]);

    const handleDisconnectEvm = useCallback(() => setEvmWallet(null), []);

    const handleMethodChange = useCallback((m) => {
        setMethod(m);
        if (BODY_METHODS.includes(m)) {
            // auto-switch to body tab when picking a body method
            if (activeTab === "params" && bodyType === "none") setBodyType("json");
            setActiveTab("body");
        } else {
            if (activeTab === "body") setActiveTab("params");
        }
    }, [activeTab, bodyType]);

    const handleSend = useCallback(async () => {
        const isEvm = network === "evm";
        if (isEvm && !evmWallet) return;
        if (!isEvm && !solWallet) return;
        if (!urlInput.trim()) return;

        const rawUrl = urlInput.trim();
        const fullUrl = buildUrlWithParams(
            rawUrl.startsWith("http") ? rawUrl : `${RESOURCE_URL}${rawUrl.startsWith("/") ? rawUrl : "/" + rawUrl}`,
            params
        );

        const extraHeaders = buildHeaders(headers);
        const {body, contentType} = buildBody(bodyType, bodyJson, bodyFields, bodyRaw);

        // Merge content-type unless user already set it
        const finalHeaders = {...extraHeaders};
        if (contentType && !finalHeaders["Content-Type"] && !finalHeaders["content-type"]) {
            finalHeaders["Content-Type"] = contentType;
        }

        let path;
        try {
            path = new URL(fullUrl).pathname + new URL(fullUrl).search;
        } catch {
            path = fullUrl;
        }

        setDetectedScheme(null);
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

        pushLog({kind: "request", text: `${method} ${path}`});

        const svmSigner = !isEvm && solWallet
            ? toSolanaSigner(solWallet.provider, solWallet.pubkey)
            : undefined;

        const {fetchWithPayment, httpClient} = createPaymentFetch({
            walletClient: isEvm ? evmWallet.walletClient : undefined,
            address: isEvm ? evmWallet.address : undefined,
            svmSigner,
            onEvent: (evt) => {
                if (evt.type === "payment-required") {
                    const r = evt.requirements;
                    if (r.scheme) setDetectedScheme(r.scheme);
                    pushLog({
                        kind: "status-402",
                        text: "402 Payment Required",
                        detail: `${r.scheme} · ${r.network} · ${formatUsdc(r.amount) ?? r.amount} → ${shorten(r.payTo)}`,
                    });
                    pushLog({
                        kind: "wallet",
                        text: isEvm ? "Requesting signature in wallet (EIP-712)…" : "Requesting Solana transaction signature…",
                    });
                } else if (evt.type === "payment-signed") {
                    pushLog({kind: "signed", text: "Payment authorization signed"});
                    pushLog({kind: "request", text: `${method} ${path}  (+ PAYMENT-SIGNATURE header)`});
                } else if (evt.type === "payment-failed") {
                    pushLog({kind: "error", text: `Payment failed: ${humanizeError(evt.error)}`});
                }
            },
        });

        try {
            const fetchOptions = {
                method,
                ...(Object.keys(finalHeaders).length > 0 ? {headers: finalHeaders} : {}),
                ...(body !== undefined ? {body} : {}),
            };

            const response = await fetchWithPayment(fullUrl, fetchOptions);
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
                const explorerBase = isEvm ? "https://sepolia.basescan.org/tx/" : "https://solscan.io/tx/";
                pushLog({
                    kind: "settled",
                    text: detectedScheme === "exact" ? "Payment settled on-chain" : "Payment settled on-chain (actual usage only)",
                    detail: settle.transaction ? `tx ${shorten(settle.transaction)}` : "confirmed by facilitator",
                });
                settle._explorerBase = explorerBase;
            }
        } catch (err) {
            const message = humanizeError(err);
            pushLog({kind: "error", text: message});
            setError(message);
        } finally {
            setIsRequesting(false);
        }
    }, [network, evmWallet, solWallet, urlInput, method, params, headers, bodyType, bodyJson, bodyFields, bodyRaw, detectedScheme]);

    const handleCopy = useCallback(() => {
        if (!result) return;
        const text = typeof result === "object" ? (result.result ?? JSON.stringify(result, null, 2)) : String(result);
        navigator.clipboard.writeText(text).then(() => {
            setCopied(true);
            setTimeout(() => setCopied(false), 2000);
        });
    }, [result]);

    // Preview URL always reflects query params
    const previewUrl = params.some((p) => p.enabled && p.key.trim())
        ? buildUrlWithParams(urlInput, params)
        : null;

    const isEvm = network === "evm";
    const walletReady = isEvm ? !!evmWallet : !!solWallet;
    const isBodyMethod = BODY_METHODS.includes(method);

    const activeParamsCount = params.filter((p) => p.enabled && p.key.trim()).length;
    const activeHeadersCount = headers.filter((h) => h.enabled && h.key.trim()).length;
    const activeBodyCount = bodyType !== "none" && bodyType !== "json" && bodyType !== "raw"
        ? bodyFields.filter((f) => f.enabled && f.key.trim()).length
        : (bodyType === "json" && bodyJson.trim() ? 1 : bodyType === "raw" && bodyRaw.trim() ? 1 : 0);

    return (
        <div className="page">
            <header className="topbar">
                <div className="brand">
                    <span className="brand__mark">
                        <img src={logo} alt="Bejibun" width={32}/>
                    </span>
                    <div className="brand__text">
                        <div className="brand__title">Bejibun x402 Playground</div>
                        <div className="brand__subtitle">A place for you to play with x402 protocol</div>
                    </div>
                </div>

                <div className="navbar-right">
                    <NavbarNetworkToggle network={network} onChange={handleNetworkChange}/>
                    <NavbarWalletConnect
                        network={network}
                        evmWallet={evmWallet}
                        solWallet={solWallet}
                        evmConnecting={evmConnecting}
                        solConnecting={solConnecting}
                        onConnectEvm={handleConnectEvm}
                        onConnectSol={handleConnectSol}
                        onDisconnectEvm={handleDisconnectEvm}
                        onDisconnectSol={handleDisconnectSol}
                    />
                </div>
            </header>

            <main className="layout">
                <section className="panel">
                    <div className="panel__header">
                        <span className="panel__eyebrow">Resources</span>
                        <h2>Send a payment request</h2>
                        <p className="panel__desc">
                            Enter any x402-protected endpoint. Choose your network, connect a wallet, and pay.
                        </p>
                    </div>

                    <div className="request-card">
                        {/* Method + URL row */}
                        <div className="url-row">
                            <select className="method-select" value={method}
                                    onChange={(e) => handleMethodChange(e.target.value)}>
                                {HTTP_METHODS.map((m) => <option key={m} value={m}>{m}</option>)}
                            </select>
                            <input
                                className="url-input"
                                type="text"
                                value={urlInput}
                                onChange={(e) => setUrlInput(e.target.value)}
                                onKeyDown={(e) => e.key === "Enter" && walletReady && !isRequesting && handleSend()}
                                placeholder="https://api.example.com/endpoint"
                                spellCheck={false}
                                autoComplete="off"
                            />
                        </div>

                        {/* Preview URL — always shows query params regardless of method */}
                        {previewUrl && (
                            <div className="url-preview">
                                <span className="url-preview__label">Preview:</span>
                                <span className="url-preview__url">{previewUrl}</span>
                            </div>
                        )}

                        {/* Tabs */}
                        <div className="req-tabs">
                            <button
                                className={`req-tab${activeTab === "params" ? " req-tab--active" : ""}`}
                                onClick={() => setActiveTab("params")}
                            >
                                Params
                                {activeParamsCount > 0 && <span className="req-tab__badge">{activeParamsCount}</span>}
                            </button>
                            <button
                                className={`req-tab${activeTab === "headers" ? " req-tab--active" : ""}`}
                                onClick={() => setActiveTab("headers")}
                            >
                                Headers
                                {activeHeadersCount > 0 && <span className="req-tab__badge">{activeHeadersCount}</span>}
                            </button>
                            {isBodyMethod && (
                                <button
                                    className={`req-tab${activeTab === "body" ? " req-tab--active" : ""}`}
                                    onClick={() => setActiveTab("body")}
                                >
                                    Body
                                    {activeBodyCount > 0 && <span className="req-tab__badge">{activeBodyCount}</span>}
                                </button>
                            )}
                        </div>

                        <div className="payload-scroll">
                            {activeTab === "params" && (
                                <KeyValueEditor rows={params} onChange={setParams} title="Query Params"
                                                keyPlaceholder="Key" valuePlaceholder="Value"/>
                            )}
                            {activeTab === "headers" && (
                                <KeyValueEditor rows={headers} onChange={setHeaders} title="Headers"
                                                keyPlaceholder="Header name" valuePlaceholder="Value"/>
                            )}
                            {activeTab === "body" && isBodyMethod && (
                                <BodyEditor
                                    bodyType={bodyType}
                                    onBodyTypeChange={setBodyType}
                                    bodyJson={bodyJson}
                                    onBodyJsonChange={setBodyJson}
                                    bodyFields={bodyFields}
                                    onBodyFieldsChange={setBodyFields}
                                    bodyRaw={bodyRaw}
                                    onBodyRawChange={setBodyRaw}
                                />
                            )}
                        </div>

                        <button
                            className="btn btn--primary send-btn"
                            onClick={handleSend}
                            disabled={!walletReady || isRequesting || !urlInput.trim()}
                        >
                            {isRequesting ? "Processing…" : "Send request & pay"}
                        </button>

                        {!walletReady && (
                            <p className="hint">
                                {isEvm ? "Connect an EVM wallet to send a payment." : "Connect a Solana wallet to send a payment."}
                            </p>
                        )}
                        {error && <div className="error-banner">{error}</div>}
                    </div>

                    <OutputBlock result={result} endpointScheme={detectedScheme} copied={copied} onCopy={handleCopy}/>

                    {settlement && (
                        <div className="settlement">
                            <div className="settlement__row">
                                <span>status</span>
                                <span>{settlement.success ? "settled" : "pending"}</span>
                            </div>
                            {settlement.transaction && (
                                <div className="settlement__row">
                                    <span>tx hash</span>
                                    <a href={`${settlement._explorerBase ?? "https://sepolia.basescan.org/tx/"}${settlement.transaction}`}
                                       target="_blank" rel="noreferrer">
                                        {shorten(settlement.transaction, 10, 8)}
                                    </a>
                                </div>
                            )}
                        </div>
                    )}

                    <p className="hint hint--muted">
                        {isEvm ? (
                            <>
                                Testnet funds:{" "}
                                <a href="https://www.alchemy.com/faucets/base-sepolia" target="_blank" rel="noreferrer">Base
                                    Sepolia ETH</a>
                                {" · "}
                                <a href="https://faucet.circle.com" target="_blank" rel="noreferrer">Circle USDC
                                    faucet</a>.
                                {" "}Want <code>batch-settlement</code>?
                                See <code>scripts/batch-settlement-client.mjs</code>.
                            </>
                        ) : (
                            <>
                                Solana payments use mainnet USDC. Make sure your Solana wallet has USDC and SOL for
                                fees.
                                {" "}Requires <code>SOLANA_PAY_TO_ADDRESS</code> and CDP keys on the server.
                            </>
                        )}
                    </p>
                </section>

                <section className="panel panel--log">
                    <div className="panel__header">
                        <span className="panel__eyebrow">HTTP exchange</span>
                        <h2>Live transcript</h2>
                    </div>
                    <div className="log" ref={logRef}>
                        {log.length === 0 && <div className="log__empty">Nothing sent yet.</div>}
                        {log.map((entry) => <LogLine key={entry.id} entry={entry}/>)}
                    </div>
                </section>
            </main>
        </div>
    );
}