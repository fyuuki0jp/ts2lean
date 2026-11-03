import { StrictMode, useEffect, useReducer, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { paymentReducer, initialPaymentState } from "./reducer";
import type { PaymentState } from "./reducer";
import "./style.css";

function App() {
  const [state, dispatch] = useReducer(
    paymentReducer,
    false,
    initialPaymentState,
  );
  const [amountText, setAmountText] = useState("100");
  const [balances, setBalances] = useState<{ alice: string; bob: string }>();
  const [balanceError, setBalanceError] = useState("");
  const [error, setError] = useState("");
  const [refreshing, setRefreshing] = useState(false);
  const session = useRef(crypto.randomUUID());
  const inFlight = useRef(false);
  const balanceVersion = useRef(0);
  const mounted = useRef(true);
  const locked = state.busy || state.failed || state.complete;
  const validAmount = /^\d{1,100}$/.test(amountText) && state.amount > 0n;

  async function refreshBalances() {
    const version = ++balanceVersion.current;
    setRefreshing(true);
    try {
      const values = await Promise.all(
        ["alice", "bob"].map(async (account) => {
          const response = await fetch(`/api/balances/${account}`);
          if (!response.ok)
            throw new Error(
              "残高を取得できませんでした。APIの起動を確認してください。",
            );
          const value = await response.json();
          if (typeof value.balance !== "string" || !/^\d+$/.test(value.balance))
            throw new Error("残高の応答が不正です。");
          return BigInt(value.balance).toLocaleString("ja-JP");
        }),
      );
      if (mounted.current && version === balanceVersion.current) {
        setBalances({ alice: values[0], bob: values[1] });
        setBalanceError("");
      }
    } catch (cause) {
      if (mounted.current && version === balanceVersion.current)
        setBalanceError(
          cause instanceof Error
            ? cause.message
            : "残高を取得できませんでした。",
        );
    } finally {
      if (mounted.current && version === balanceVersion.current)
        setRefreshing(false);
    }
  }
  useEffect(() => {
    mounted.current = true;
    void refreshBalances();
    return () => {
      mounted.current = false;
      ++balanceVersion.current;
    };
  }, []);

  async function send() {
    // The synchronous lock also blocks duplicate events before React commits a render.
    if (inFlight.current) return;
    const action = state.failed
      ? { kind: "retry" as const }
      : { kind: "submit" as const };
    const next = paymentReducer(state, action);
    if (next === state || !next.busy) return;
    inFlight.current = true;
    dispatch(action);
    setError("");
    const request = next.request;
    const operationId = `${session.current}-${next.operation}`;
    const from = next.fromAlice ? "alice" : "bob";
    const to = next.fromAlice ? "bob" : "alice";
    try {
      const response = await fetch("/api/transfers", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          operationId,
          from,
          to,
          amount: next.amount.toString(),
        }),
        signal: AbortSignal.timeout(15_000),
      });
      const receipt = await response.json();
      if (!response.ok)
        throw new Error(
          receipt.error === "insufficient funds"
            ? "残高が不足しています。"
            : "送金結果を確認できませんでした。",
        );
      if (
        receipt.operationId !== operationId ||
        receipt.from !== from ||
        receipt.to !== to ||
        receipt.amount !== next.amount.toString()
      )
        throw new Error("送金結果が依頼内容と一致しません。");
      if (mounted.current) dispatch({ kind: "success", request });
    } catch (cause) {
      if (mounted.current) {
        setError(
          cause instanceof Error && cause.name !== "TimeoutError"
            ? cause.message
            : "送金結果を確認できませんでした。",
        );
        dispatch({ kind: "failure", request });
      }
    } finally {
      inFlight.current = false;
      if (mounted.current) void refreshBalances();
    }
  }
  function edit(amount: string, fromAlice: boolean) {
    setAmountText(amount);
    dispatch({
      kind: "edit",
      amount: /^\d{1,100}$/.test(amount) ? BigInt(amount) : 0n,
      fromAlice,
    });
  }
  function status(s: PaymentState) {
    if (s.busy)
      return "送金処理中です。画面を閉じたり再読み込みしたりせずにお待ちください。";
    if (s.failed) return `${error} 同じ送金内容・IDで再試行できます。`;
    if (s.complete) return "送金が完了しました。";
    if (!validAmount) return "金額は1以上の整数で入力してください。";
    return "送金内容を入力してください。";
  }
  return (
    <>
      <header>
        <strong>ts2lean / Payments</strong>
        <span>ローカルデモ</span>
      </header>
      <main>
        <h1>送金</h1>
        <p className="intro">口座間の送金と、処理状況を確認できます。</p>
        <div className="columns">
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void send();
            }}
          >
            <fieldset disabled={locked}>
              <label htmlFor="from">送金元</label>
              <select
                id="from"
                value={state.fromAlice ? "alice" : "bob"}
                onChange={(e) => edit(amountText, e.target.value === "alice")}
              >
                <option>alice</option>
                <option>bob</option>
              </select>
              <label htmlFor="to">送金先</label>
              <select
                id="to"
                value={state.fromAlice ? "bob" : "alice"}
                onChange={(e) => edit(amountText, e.target.value === "bob")}
              >
                <option>bob</option>
                <option>alice</option>
              </select>
              <label htmlFor="amount">金額</label>
              <input
                id="amount"
                inputMode="numeric"
                maxLength={100}
                value={amountText}
                onChange={(e) => edit(e.target.value, state.fromAlice)}
                aria-describedby="amount-help"
                aria-invalid={!validAmount}
              />
              <small id="amount-help">最小通貨単位</small>
            </fieldset>
            <div className="actions">
              {state.complete ? (
                <button
                  type="button"
                  onClick={(event) => {
                    event.preventDefault();
                    dispatch({ kind: "reset" });
                  }}
                >
                  新しい送金
                </button>
              ) : (
                <button
                  type="submit"
                  disabled={state.busy || (!state.failed && !validAmount)}
                >
                  {state.busy
                    ? "送金中…"
                    : state.failed
                      ? "同じIDで再試行"
                      : "送金する"}
                </button>
              )}
            </div>
            <p
              role="status"
              className={
                state.failed || !validAmount ? "status error" : "status"
              }
            >
              {status(state)}
            </p>
            {state.failed ? (
              <p className="hint">
                結果が未確認の送金は、サーバーに保存されている場合があります。再読み込みせず、この画面から再試行してください。
              </p>
            ) : null}
          </form>
          <aside aria-labelledby="balances-title">
            <h2 id="balances-title">口座残高</h2>
            <dl>
              <div>
                <dt>alice</dt>
                <dd>{balances?.alice ?? "—"}</dd>
              </div>
              <div>
                <dt>bob</dt>
                <dd>{balances?.bob ?? "—"}</dd>
              </div>
            </dl>
            {balanceError ? (
              <p role="alert" className="error hint">
                {balanceError}
              </p>
            ) : null}
            <button
              type="button"
              className="secondary"
              disabled={refreshing}
              onClick={() => void refreshBalances()}
            >
              {refreshing ? "更新中…" : "更新"}
            </button>
          </aside>
        </div>
      </main>
      <footer>実際の金融機関には接続しません。</footer>
    </>
  );
}
createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
