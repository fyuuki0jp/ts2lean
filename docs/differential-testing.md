# 意味的な対応を検査する差分テスト

```sh
npm run test:differential
node scripts/differential.mjs --seed 42 --count 100
node scripts/differential.mjs --replay .ts2lean/differential/run-XXX/case-0.json
npm run test:semantics
```

生成したTypeScriptをTypeScript transpilerでJavaScriptへ変換して別プロセスで実行します。比較先は本番のcompilerとemitterが生成したLeanモデルの`#eval`です。JavaScript側の正解をts2leanのIRから作りません。整数はdecimal stringで比較し、0、±1、大きな整数、両boolean値を含めます。

seedを固定し、ソースと入力をversion付きJSONで保存します。replayは生成器を再実行せず、保存したソース・入力を使います。実行ディレクトリは分離されます。不一致があれば小さい入力候補でも同じ不一致が残るか確認し、元の入力・両結果と縮小後のケース、Leanモデル、Node／Lean toolchain情報を保存して非ゼロ終了します。コンパイル失敗や実行エラーは成功として扱いません。

初期の生成文法はbigint／boolean入力、分岐、局所更新、分割代入、readonly record、shadowing、設定値DIです。各実行の最後に生成Leanの加算を減算へ変更し、比較器が意図的な誤訳を検出できることも検査します。

`test:semantics`はさらに既存のcompletionテストを実行します。こちらはtry/catch/finally、return/throw、基本操作の成功・更新前失敗・更新後失敗を列挙し、終了結果と状態の観測値を比較します。構造実行の包含証明と、意図的な経路削除の拒否も検査します。

## 保証と残る作業

有限の生成テストは、TypeScript全体の意味的等価性の形式証明ではありません。現在のcompletion比較も、全状態や操作traceの双方向同値を示すものではありません。TypeScript→IR、テストcodec、TypeScript／JavaScript実行系、Lean実行系と外部操作のモデルは信頼境界です。

次の拡張は判別可能unionの全variant、非同期DIの例外と局所状態、在庫予約の競合・再試行です。差分基盤も、型を保つプログラム構造の縮小、複数種類の変換mutation、completionの完全な状態・操作traceの比較へ広げます。現時点で縮小するのは入力値です。
