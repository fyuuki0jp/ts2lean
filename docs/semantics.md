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

## 現在の対応範囲と次の拡張

0.1.1時点の純粋関数と外部操作の対応範囲は次のとおりです。未対応のコードを近似して証明済みにはしません。

| 用途 | 現在の境界 |
| --- | --- |
| 整数counter・小数timeline | `Int`に対応する`bigint`のみ。JavaScriptの`number`は未対応 |
| ID・hash比較 | 一般の`string`入力・返値は未対応。unionの文字列タグや台帳プロファイル内の文字列とは区別する |
| nullable・optional | 一般の純粋関数の`T \| null`、`T \| undefined`、optional propertyは未対応。台帳のnullable要求は専用モデル |
| discriminant | required readonly recordの`kind`文字列タグに対応。`{ok:true,value}\|{ok:false,error}`は未対応 |
| reducer | boolean分岐、対応型の局所更新、`kind` unionに対応。`switch`、record spread、配列操作は未対応 |
| DBポート | `ledger-v1`の操作と明示した外部法則のみ。D1の任意CAS・lease・checkpointは未対応 |

導入先のJSON・DB・UIとの互換性を保つため、次の段階で拡張します。以下は実装計画であり、0.1.1の機能ではありません。

1. **文字列・欠損値・booleanタグ**：ID/hashの等値比較をUTF-16 code unit列で定義します。プロパティなし、存在する`undefined`、`null`、値を区別します。unionのタグ名・タグ値を明示するmetadataを追加し、`ok: true/false`の判定と構築へ接続します。constructor名からbooleanタグを推測しません。
2. **IEEE754のnumber**：公開TypeScript型を`number`のまま保ち、binary64の丸め、NaN、±Infinity、±0、subnormal、strict equalityをモデル化します。安全な整数counterには範囲条件下で整数算術へ接続する証明補題を使い、小数timelineには丸めを保った順序・範囲・誤差の契約を使います。`Int`やLeanの`Float`へ単に置換して対応済みとはしません。
3. **readonly配列とreducer**：通常のdense arrayと純粋callbackから始め、membership/filter/map、slice、範囲外アクセス、undo/redoを扱います。`includes`のSameValueZeroと`===`を区別し、`readonly`型だけをdense arrayの証拠にしません。record spreadはown data propertyのshallow copyと後勝ち上書きを保持します。`switch`はliteral discriminant・fallthroughなしから対応し、未対応fallthroughは拒否します。
4. **任意の明示的ポート契約**：操作の引数・結果・成功/拒否後の状態をLeanの遷移関係で定義し、既存のCompletion意味論へ接続します。CASの不可分性、leaseのowner/token/時刻、checkpointの再送条件は個別の外部法則として示します。操作列全体を暗黙にtransaction化せず、D1自体を証明したとは主張しません。

各段階でLeanの値モデル、型宣言、変換、証明ルール、独立したJavaScript/Lean実行比較、意図的な誤変換の拒否を揃えます。Numberでは`2^53`周辺、`0.1 + 0.2`、丸め・overflow・underflow・NaN・±0、文字列では孤立surrogate、欠損値ではproperty presence、配列では順序・空配列・入力非変更を検査します。検証用codecはbit表現やタグを使えますが、アプリのJSON表現は変更しません。未証明は`unproved`、未対応は`unsupported`のまま返します。

一般ヒープのidentity/alias、getter/Proxy、任意ループ、effect内の局所更新、Promise/thenableのスケジューラは別の拡張です。UI・DB・ホストAPIとの境界は、上記機能を加えた後も明示します。

## 所有モジュール内のLean契約

0.1.1から、`src/features/edit-routine/model/Access.lean`のようにハイフンを含むディレクトリ・ファイル名を使えます。ViteとContent Mapperをリポジトリrootで一つ設定し、TypeScriptから通常の相対importで読み込みます。

```ts
import { canEdit } from "./src/features/edit-routine/model/Access.lean";
```

Leanファイル同士のimportでは、ハイフンを含む要素を引用識別子にします。

```lean
import src.features.«edit-routine».model.Access
```

生成コードは各要素を`«edit-routine»`のように引用し、ファイル配置は変更しません。Leanの引用識別子は引用前と同じ名前を表し、ハイフンも保持します。[Leanの識別子仕様](https://lean-lang.org/doc/reference/latest/Source-Files-and-Modules/)

対応するパス要素はASCII英字または`_`で始まり、以降はASCII英数字・`_`・`-`です。config root外の仕様、識別子に埋め込まれた区切り・ドット・改行・引用記号は拒否します。コンパイル対象も作業ディレクトリ内に制限し、外部へ解決されるsymlinkを拒否します。契約のnamespace・公開宣言名は従来どおり単純な識別子を使います。

純粋関数の自動証明は`simp`・分岐分割・`omega`を試し、残る命題には`grind`を試します。booleanの含意からdisjunctionを導く契約もそのまま記述できます。生成された証明は引き続きLeanカーネルと公理監査で検査し、証明失敗を成功扱いにはしません。

## 純粋関数の静的DIと局所更新

`src/static.ts`は依存の配線だけをASTから解決します。関数・オブジェクトのポートをfactoryへ注入し、返された関数やサービスメソッドのcapture環境を保持します。`src/compiler.ts`は具体的な環境ごとに関数を特殊化するため、同じfactoryでも異なる実装を注入したインスタンスを混同しません。factoryに任意のJavaScript処理を実行させて依存を推測することはありません。

`let`や局所代入は、更新ごとに新しいLeanのlet束縛を作ります。ifの後続処理には各分岐の終了時の環境を渡し、ブロックを出るときには外側のbindingに対する更新だけを引き継ぎます。シャドーイングはTypeScriptのsymbolで区別します。これは純粋関数プロファイルの拡張であり、effect callbackの状態モデルや一般ヒープへの代入対応ではありません。

実行時にはクロージャの元の生成位置とexport先を別々に登録します。さらに、factoryと現在の依存関数を検証の前後で照合します。依存オブジェクトはown data propertyを読み、getterとProxyは拒否します。namespace importのexportを取り出した後も、入れ子のポートでは同じ検査を行います。検証後に依存が変更されないことは利用側の前提です。

`test/architecture.test.mjs`は複数の特殊化と局所更新をJavaScript／Leanで比較します。`test/vitest.test.mjs`はfactory・ポートのmock、検証中の変更、namespace・名前のshadowing・入れ子Proxyを含む実参照チェックを確認します。利用例は`examples/architectures/`にあります。

Vitestのディスクキャッシュには、計装処理の実装とプラグイン設定をキーとして含めます。Leanの宣言探索はimport先の仕様にも依存するため、`.lean`の変換結果はディスクキャッシュせず毎回読み直します。

## union・非同期DIと独立した実行比較

純粋関数の`kind`付きunionをLeanの帰納型に対応させ、タグ分岐をconstructor別のmatchへ変換します。同期factoryが返すasyncサービスはcapture環境ごとに特殊化し、既存ledger-v1の意味論へ接続します。factoryの実行自体は不変の依存の束縛と返却に限定します。

JavaScriptから得た返値・タグ・payload、およびcallbackの完了・局所状態・操作順序をLean評価と比較する生成テストをCIに含めます。seedとソースを保存し、失敗をreplayできます。[差分テストの実行方法と有限な観測範囲](differential-testing.md)を参照してください。
