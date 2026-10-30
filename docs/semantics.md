# TypeScriptの意味を保つための検証基盤

目標は、利用者のコードを専用DSLへ書き換えず、TypeScriptの実行時の意味をLeanへ移すことです。対応構文を増やす際も、未対応の挙動を消したり、検証に都合のよい挙動へ置き換えたりしません。TypeScriptの型注釈が消えた後のJavaScriptの挙動を基準にします。

## 現在の証明経路

```text
TypeScript callback
  ├─ 構造IR → Lean Program.exec / Program.wp
  └─ 記号実行 → 全completionの経路関係
                       ↑
            Leanが包含定理を検査
                       ↓
              成功経路の不変条件保存
                       ↓
    DB法則の下で任意有限回のコミット・障害に対する安全性
```

`src/effects/structured.ts`はconst、逐次実行、if、return、throw、try/catch/finally、基本操作へのawaitを構造として保存します。成功経路から逆算してプログラムを組み立てません。`compiler.ts`の記号実行とは独立してASTを下げるため、記号実行が経路を落とすと包含証明が失敗します。純粋な式の翻訳は両経路で共有しています。

`lean/Ts2Lean/Completion.lean`の`Program`は、実行関係`exec`、事後条件から必要条件を組み立てる`wp`、そのルールの健全性証明`sound`を持ちます。bind、catch、finallyなどの合成規則はLeanで証明しています。

生成物の`callback_N_completion_refines`は、正常終了・return・throwを含む構造的な実行が`CompletionModel`に含まれることを示します。`callback_N_refines`が成功実行を既存の成功経路へ接続します。最終的な`all_executions`・`successful_response`・`durable_receipts`は、成功経路の列挙を直接DBの振舞いと仮定せず、構造的な`ExtractedCallback`を対象にします。

## Completionの意味

| 構文 | 意味 |
| --- | --- |
| 文の並び・const | normalだけが次の処理へ進む。returnとthrowは伝播する |
| return | その時点の値と状態を保持して関数を終了する |
| throw | 例外値と状態を保持して例外終了する。書込みを自動で巻き戻さない |
| catch | throwだけを捕捉し、例外発生時の状態から処理する。引数への束縛・再送出に対応する |
| finally | どの終了理由でも実行する。正常終了なら元の終了理由を復元し、状態はfinalizer後のものを使う。finalizerのreturn・throwは元の終了理由を上書きする |
| await | 対応する外部操作の成功値をnormal、拒否値をthrowとして扱う |

この制御規則は[ECMAScriptのtry文](https://tc39.es/ecma262/multipage/ecmascript-language-statements-and-declarations.html#sec-try-statement-runtime-semantics-evaluation)と[Await](https://tc39.es/ecma262/multipage/control-abstraction-objects.html#await)を参照しています。

現在の外部操作は台帳プロファイルです。読み取り失敗、書込み前の失敗、書込み後の失敗を扱います。外部操作の拒否値は全称量化し、一種類の固定エラーとは仮定しません。callback内で捕捉されれば部分的な局所更新が残り、callback全体が失敗すればDB法則によりロールバックします。

throwできる値は、文字列、bigint、boolean、null、undefined、標準Error、捕捉した例外です。Errorのidentity・stack・任意プロパティの観測は未対応です。三項演算子は同じ対応型を返す純粋な分岐、null比較はnullableな要求レコードに対応します。

## 確認方法

`test/completion.test.mjs`では実際のTypeScriptをJavaScriptへ変換して実行し、同じ入力と基本操作の成功／更新前失敗／更新後失敗について、終了値・例外・局所状態をLeanのモデル評価と比較します。対象ケースの全障害列を列挙しますが、これは有限の比較テストであり、言語全体の等価性証明ではありません。

さらに、構造IRを残したまま正常経路や例外経路を削った生成物がLeanで拒否されることをテストします。finallyが例外をreturnで握りつぶして不正な部分更新をコミットする例は、変換の包含証明は通り、業務の不変条件証明が失敗します。この二つを混同しません。

```sh
npm run test:semantics
npm run test:payments
npm test
```

## 残る信頼境界

今回証明したのは、生成した構造的callbackの実行と、記号経路・不変条件との関係です。**ECMAScriptからLeanへの変換器全体を形式検証したわけではありません。** AST→構造IR、共有する純粋式の翻訳、入力が通常の型どおりのデータであること、DBアダプターのrefinementは依然として前提です。共通の式翻訳が両経路で同じ誤りをすると、包含証明だけでは発見できないため、文字列のescapeなども実行比較に含めます。

外側の関数は、到達するトランザクションの探索と、任意の順序・キャプチャ値への安全側の抽象化を維持しています。finally内のトランザクションも探索しますが、service全体のPromiseスケジューラやマイクロタスク列をLeanで実行するモデルではありません。DBの基本操作の失敗モデルも外部契約による安全側の範囲であり、SQLiteの全内部挙動との双方向の等価性を主張しません。

## 拡張する順序

1. 式内の副作用と評価順序：副作用を含む三項演算、短絡評価、複合代入、複数引数の評価順序を共通IRへ下げる。
2. effect側の局所変数とループ：純粋関数で対応したlet・代入をeffectの環境へ広げ、break/continue、label、ループ不変条件、IteratorCloseを扱う。
3. ヒープ：参照identity、alias、配列、object、property descriptor、getter/setter、prototype、classを扱う。
4. JavaScriptの値：IEEE 754のnumber、NaN、符号付きゼロ、UTF-16文字列、型変換・truthinessを扱う。現在のIntやUnicode文字列へ近似して済ませない。
5. 呼出しと非同期処理：closure、this、動的dispatch、Promise状態、thenable、マイクロタスク、並行コンビネータを扱う。
6. 標準組込み・ホストAPI：操作意味論と法則、実装への対応証拠を分離する。

各拡張では、構造的意味論、変換、証明ルール、実行比較、意図的に壊した変換の拒否を揃えて対応を宣言します。現段階でこれら全体が対応済みという意味ではありません。

## 純粋関数の静的DIと局所更新

`src/static.ts`は依存の配線だけをASTから解決します。関数・オブジェクトのポートをfactoryへ注入し、返された関数やサービスメソッドのcapture環境を保持します。`src/compiler.ts`は具体的な環境ごとに関数を特殊化するため、同じfactoryでも異なる実装を注入したインスタンスを混同しません。factoryに任意のJavaScript処理を実行させて依存を推測することはありません。

`let`や局所代入は、更新ごとに新しいLeanのlet束縛を作ります。ifの後続処理には各分岐の終了時の環境を渡し、ブロックを出るときには外側のbindingに対する更新だけを引き継ぎます。シャドーイングはTypeScriptのsymbolで区別します。これは純粋関数プロファイルの拡張であり、effect callbackの状態モデルや一般ヒープへの代入対応ではありません。

実行時にはクロージャの元の生成位置とexport先を別々に登録します。さらに、factoryと現在の依存関数を検証の前後で照合します。依存オブジェクトはown data propertyを読み、getterとProxyは拒否します。namespace importのexportを取り出した後も、入れ子のポートでは同じ検査を行います。検証後に依存が変更されないことは利用側の前提です。

`test/architecture.test.mjs`は複数の特殊化と局所更新をJavaScript／Leanで比較します。`test/vitest.test.mjs`はfactory・ポートのmock、検証中の変更、namespace・名前のshadowing・入れ子Proxyを含む実参照チェックを確認します。利用例は`examples/architectures/`にあります。

Vitestのディスクキャッシュには、計装処理の実装とプラグイン設定をキーとして含めます。Leanの宣言探索はimport先の仕様にも依存するため、`.lean`の変換結果はディスクキャッシュせず毎回読み直します。

## union・非同期DIと独立した実行比較

純粋関数の`kind`付きunionをLeanの帰納型に対応させ、タグ分岐をconstructor別のmatchへ変換します。同期factoryが返すasyncサービスはcapture環境ごとに特殊化し、既存ledger-v1の意味論へ接続します。factoryの実行自体は不変の依存の束縛と返却に限定します。

JavaScriptから得た返値・タグ・payload、およびcallbackの完了・局所状態・操作順序をLean評価と比較する生成テストをCIに含めます。seedとソースを保存し、失敗をreplayできます。[差分テストの実行方法と有限な観測範囲](differential-testing.md)を参照してください。
