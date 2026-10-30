# 決済基盤のドッグフーディング

単一通貨・最小通貨単位の`bigint`による、口座・台帳・冪等な送金APIです。実DBはNode.jsの`node:sqlite`によるSQLite。**これは実験的な形式検証の題材であり、銀行・カード・Stripe APIには接続しません。**

## 実行

リポジトリのルートで実行します。Node.js 24、依存パッケージ、Lean 4.35.0が必要です。

```sh
npm ci
npm run build
npm run typecheck:payments
npm run test:payments
```

通常のサービスはLeanを実行せずに動きます。`seed`は新しいDBに一度だけ実行します。

```sh
export PAYMENTS_DB=/tmp/payments-demo.sqlite
node examples/payments/cli.ts seed '{"alice":"1000","bob":"0"}'
node examples/payments/cli.ts transfer op-1 alice bob 100
node examples/payments/cli.ts recover
node examples/payments/cli.ts snapshot
node examples/payments/server.ts
```

```sh
curl http://127.0.0.1:3000/transfers \
  -H 'content-type: application/json' \
  -d '{"operationId":"op-2","from":"alice","to":"bob","amount":"50"}'
curl http://127.0.0.1:3000/balances/alice
```

HTTP層はローカル実験用です。認証・認可・公開運用・HTTP層自体の形式検証は含みません。

## 実装と仕様

| ファイル | 役割 |
| --- | --- |
| `service.ts` | 普通のasync関数、アロー関数、try/catch、トランザクションcallbackによる送金・再試行・復旧 |
| `Database.lean` | Content Mapperが公開するモジュール型、操作ID、DBの外部保証と設定 |
| `database.ts` | `type`→`interface extends`→`satisfies`によるDB法則の対応付け |
| `sqlite.ts` | 実SQLiteアダプター。低水準の読み書きを提供し、送金の安全性を肩代わりしない |
| `Payment.lean` | 初期条件、台帳不変条件、成功応答の仕様、許される障害イベント |
| `payments.test.ts` | 実関数参照からのLean検証と、通常の実行テスト |
| `bugs/*.ts` / `counterexamples.ts` | 意図的な不具合と、実SQLiteでの再現可能な実行列 |

入力は、文字列の`operationId/from/to`と、正の`bigint`の`amount`です。送金元と送金先は別口座、operationIdは空でないことが必要です。IDは正しくUnicodeとして表現できる文字列、入力はgetter/proxyを持たない通常のデータレコードを検証モデルの対象とします。HTTP入口はさらにASCII識別子へ制限します。残高不足・未知の口座では送金は成功しません。呼出し元によるawait中の変更を避けるため、関数入口で入力をローカルにコピーします。

最初のトランザクションで送金内容を永続化します。同じoperationId・同じ内容は再利用し、違う内容は拒否します。次のトランザクションで依頼・既存記帳・残高を読み直し、残高更新と記帳を一括コミットします。失敗した依頼はpendingに残り、`recover`が元のIDのまま再試行します。

台帳は**送金1件を借方・貸方の組として保持する**コンパクトな二重仕訳表現です。1行に送金元・送金先・金額を持ち、各口座への符号付き効果をLeanの`flow`で定義します。個別の任意仕訳行や手数料は今回のモデルには含めません。

## 何を証明するか

```ts
await expect(transfer).toVerify(transferContract);
await expect({ transfer, retryPendingTransfers, recover })
  .toPreserveInvariant(ledgerInvariant);
```

`ts2lean/runtime`の`verifySystem`は同じ検証の結果オブジェクトを返します。検証は関数をサンプル実行しません。実際のTypeScript ASTと型の宣言元から、到達する各transaction callbackの成功経路・状態更新・返値を抽出します。生成物は`.ts2lean/run-*/Proof.lean`と`ir.json`です。元の行番号とDB操作列も含みます。

Leanは以下を確認します。

- 初期状態で不変条件が成立する。
- 抽出された全コミットが、残高非負、総額保存、残高と台帳の一致、operationIdの一意性、依頼と記帳の一致を保つ。
- 成功したcallbackのreceiptは記帳済みで、要求内容と一致する。
- pending再試行が元のoperationIdを保つ。
- 任意有限回のコミット・中断・停止・応答消失・再起動を経ても不変条件が保たれる。
- 一度記帳されたreceiptは、その後の有限実行でも消えない。

callbackのキャプチャ値を全称量化し、全トランザクションを任意順序で繰り返せるようにします。これにより、await間の並行実行や古いpending一覧を安全側に含めます。リクエスト全体を一つの原子操作と仮定しません。トランザクション内部の一時状態には不変条件を要求せず、成功コミット時だけ要求します。

共通ライブラリの`register_safe`・`settle_safe`は、行操作の定義からLeanで証明した代数的補題です。生成された実装の状態更新がその補題と一致するときだけ適用できます。送金実装が安全だという仮定ではありません。実装を壊すと、生成された状態式についての証明が失敗します。

## 外部仮定と保証の境界

DBアダプター自体、SQLite、OS、ストレージ、TypeScript→Lean変換器は形式検証済みではありません。結果の`assumptions`に、型の対応元・設定・使用した外部法則を**assumed**として記録します。`satisfies`だけで法則が証明されたとは扱いません。独自公理や`sorry`は拒否します。

DB側の前提は、独立した`DatabaseLaws db`を引数とする条件付き定理として使います。

- `BEGIN IMMEDIATE`によるwriterの直列化。callbackを順番通りに実行し、成功した全体だけを原子的にコミットする。
- コミット前の例外・プロセス停止では未コミットの書込みを破棄する。
- コミット後に応答だけが失われても、コミット済みデータを残す。
- `journal_mode=WAL`、`synchronous=FULL`、`read_uncommitted=OFF`、正常なfilesystem sync。
- キーによる読み取り・上書き・一意な挿入・pending一覧・整数のencode/decodeが、宣言した操作と一致する。

実行時設定は`settings()`で照合します。金額はSQLiteの64bit整数ではなくdecimal TEXTで保存し、`bigint`と正確に往復させます。外部からの直接SQL更新、別の未検証writer、稼働中のseed、DBや標準組込みの差し替えは保証の対象外です。証明開始前と返却直前に関数・依存関数・DBオブジェクト・メソッド・ソースの同一性を確認します。検証完了後の差し替えまで保証するものではありません。

停止・再起動はモデル内のイベントです。証明するのは安全性であり、公平性、必ず完了すること、無限実行の活性、ストレージ破損やfsyncを無視するハードウェア障害ではありません。

## 負例と通常のテスト

`test/payments.test.mjs`は正しいコードの証明に加え、以下の変更が検証成功にならないことを確認します。

| 負例 | 具体的な実行列 |
| --- | --- |
| 古い残高をトランザクション外で読む | 残高100をA/Bがともに読み、各80を送金。送金元20、送金先160となり総額が180になる |
| 残高更新だけをコミットする | 同じIDで再試行すると、記帳がないまま2回残高が変わる |
| retryでIDを変える | 元の処理を途中中断し、別IDでrecover。その後、元IDで再送すると2件記帳される |

新しいDBファイルで各負例を再現できます。

```sh
PAYMENTS_DB=/tmp/broken-stale.sqlite node examples/payments/counterexamples.ts stale-balance
PAYMENTS_DB=/tmp/broken-posting.sqlite node examples/payments/counterexamples.ts missing-posting
PAYMENTS_DB=/tmp/broken-retry.sqlite node examples/payments/counterexamples.ts changed-retry-id
```

通常のテストには、同一IDの並行リクエスト、内容の競合、複数プロセスの競合、各書込み後とコミット後のSIGKILL、再起動・復旧、入力の変更、モックの拒否を含めます。有限回の実行テストを任意実行の証明とは呼びません。

`unproved`は自動証明の失敗、`unsupported`は未対応の構文・意味論、`type-error`は型不整合です。`counterexamples.ts`の`counterexample`は実DB上で破綻を確認した具体例です。単なるLeanの失敗を反例発見とは報告しません。

## 現在の制約

effect検証は汎用TypeScript検証器ではなく、**1つの共有DBに対する`ledger-v1`操作プロファイル**です。Leanから任意の外部操作意味論を追加する仕組み、証明済みDBアダプターの証拠の取り込みは未実装です。モジュールAPIの型・法則のidentityはLean宣言から取得しますが、基本操作の数学的意味と証明ルールは共通ライブラリが提供します。

通常のasync関数・アロー関数、const、if、早期return、文字列・bigint・要求レコード、try/catch/finally、捕捉した例外の再送出、明示的なawait、inline transaction callback、pending一覧のfor-ofに対応します。対応外は黙って無視せず停止します。

再帰、一般的なループ、callback内のhelper呼出し、ネストしたトランザクション、transactionの外への持ち出し、fire-and-forget、helperの返値契約の合成、任意の可変オブジェクト、複数DBをまたぐ操作などは未対応です。Lean仕様の状態型も現在はこの台帳に特化しています。別の不変条件や自動化で解けない条件は`unproved`になります。

## 制御フローの証明強化

callbackの制御構造を保持したLean実行意味論と、正常・return・throwの全経路の包含証明を追加しました。記号経路を削った変換は検証成功になりません。finallyの完了上書きや部分更新もJavaScriptと比較しています。[意味論・信頼境界・拡張方針](../../docs/semantics.md)を参照してください。

## 非同期サービスへのDI

`service-factory.ts`の`createPaymentService({db})`が送金・再試行・復旧のasyncメソッドを返し、`composition.ts`で実DBを注入します。非同期helperの注入も同じ仕組みです。`di.test.ts`で、同一factoryの複数instance、元の業務契約、helperのmock、DBのgetter／Proxyを検査します。

注入元のconstにLean由来の名目的なDB型を必要とします。factory parameterの構造的な型だけで法則を認定しません。複数のサービスは同一の実DB handleを共有する必要があります。factoryは同期・静的な組立てに限り、返される関数はasyncにできます。証明前後にfactory・closure環境・DB・helperを照合し、`settings()`採取後にもユーザーコードを呼ばず同一性を再確認します。
