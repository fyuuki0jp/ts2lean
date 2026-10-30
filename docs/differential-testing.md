# TypeScript／Leanの意味的な対応を検査する差分テスト

```sh
npm run test:differential
node scripts/differential.mjs --seed 42 --count 100
node scripts/differential-effects.mjs --seed 42 --count 100
node scripts/differential.mjs --replay .ts2lean/differential/run-XXX/case-0.json
node scripts/differential-effects.mjs --replay examples/payments/.ts2lean/differential-XXX/case-0.json
npm run test:semantics
```

## 比較するもの

TypeScript transpilerが生成したJavaScriptを実行し、本番のcompiler／emitterが生成したLeanモデルの`#eval`結果と比較します。JavaScript側の正解をts2leanのIRから作りません。pureは別Nodeプロセス、effectsはテスト用DBを注入したJavaScript実行です。replay対象はローカルの信頼できる生成ケースを使います。

| プロファイル | 生成するコード | 観測対象 |
| --- | --- | --- |
| pure | 深さ制限付きの再帰的な整数式、boolean分岐、局所更新、分割代入、record、shadowing、設定値DI、unionの全variant | 戻り値の型・タグ・全payload。bigintはdecimal string |
| completion-ledger | try/catch/finally、return/throw、DB read/write、同期factoryへの非同期DB注入 | 完了値／例外、alice/bobの残高と総額、caseの依頼全フィールド、台帳全行、操作順・引数・成功／失敗 |

pureは0、±1、ランダム値、±10^40、両boolean値を含めます。effectsはrollback前のcallback内部の局所状態を対象に、固定の入力・初期状態で各操作の成功／更新前失敗／更新後失敗を列挙し、有限の観測結果集合を双方向に比較します。readの失敗前後は状態が同じなので同じ観測になります。外部例外はこの生成テストでは`Error("fault")`に固定し、別のcompletion回帰テストで文字列・bigint・boolean・null・undefinedや再送出を扱います。

effectsでは、さらに元のcallback制御構造から生成したLean実行関係が記号経路に含まれることをカーネルで検査します。これはJavaScriptとLeanの等価性証明ではなく、変換後の二つの表現間の包含証明です。

## 再現・縮小・検出器の検査

seed、ソース、入力／障害上限をversion付きJSONで毎回保存します。replayは生成器を再実行せず、保存したケースを使います。各実行は独立したディレクトリを持ちます。コンパイル失敗、証明失敗、実行エラー、観測数の不一致も非ゼロ終了します。CIはケース・エラー・reportをartifactとして保存します。

pureの不一致は整数入力の絶対値を小さくして再検査し、元と縮小後の入出力・Leanモデル・Node／Lean toolchainを保存します。effectsは元のソースと両観測集合・Leanモデルを保存します。effectsの縮小、型を保つプログラム構造の縮小、最小反例の保証は未実装です。

毎回、pureでは加算を減算へ、effectsでは読み取り順序を逆順へ意図的に壊し、比較器が拒否することを確認します。completion回帰テストは成功経路／例外経路を削ると包含証明が失敗することも確認します。生成テストで見つかった「読み取り値をwriteへ渡した場合のLean引数の括弧不足」は生成文法に残しています。

## 保証の境界

有限テストはTypeScript全体や無限個の入力に対する意味的等価性の証明ではありません。generator、codec、TypeScript→IR、JavaScript／Lean実行系、外部操作モデルは信頼境界です。手動回帰テスト・生成テスト・変換後の包含証明・業務契約の証明・外部DB法則の仮定を区別します。

特にeffectsの比較は二口座・一つのoperationId・有限個の操作を対象とします。任意の状態、任意のキー、全例外値、実DBのスケジュールを網羅しません。DBの耐久性・直列化・クラッシュは決済exampleの通常テストと条件付きLean定理で別途検査します。在庫予約の汎用repository意味論、Promise combinator、一般ループ、effect内の可変局所変数は今後の拡張対象です。
