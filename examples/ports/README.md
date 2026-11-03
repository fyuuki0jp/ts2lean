# 実asyncユースケースと任意ポートの逐次検証

```ts
import {bindPort, verifyUseCases} from "@fyuuki0jp/ts2lean";
import {authorization, storage, save} from "./Save.lean";

const result = await verifyUseCases([
  {fn: service.save, contract: save},
  {fn: service.saveViaHelper, contract: save},
], {ports: [
  bindPort(adapter, "authorize", authorization),
  bindPort(adapter, "commit", storage),
]});
```

実際のreceiver・メソッド・クロージャ・ソースsnapshotを使い、検証前後に参照を再確認します。アダプターを実行したりラップしたりしません。未計装の組込み・外部メソッドは`bindPort(..., {boundary: "外部adapterと責務の具体的説明"})`で明示します。仮定レポートにはreceiver/methodの識別子、key、取得可能なソースpath/span/hashが入ります。これらは検証1回の範囲内の識別子です。

Leanの`PortContract State Event Unit Input Output`に、引数、返値、全結果と状態遷移の関係、呼出し・終了イベントを定義します。`fulfilled`には通常のResultの成功と拒否を含め、Promise rejectionと同期throwはそれぞれ`rejected`・`threw`で定義します。各入力に対する返値の存在、および各例外結果を許す状態の存在を`fulfills`・`rejects`・`throws`で証明するため、空の遷移や成功しか許さないモデルは受理しません。`Result.err`だけを返す正当なポートも表現できるため、業務の成功経路が到達可能であることは別途確認してください。

例外payloadは`Unit`へ抽象化し、その内容・同一性・型を観測しません。JavaScriptでは元の例外が伝播します。例外の発生や発生前後の永続状態は消しません。更新後の例外、CAS敗北、拒否の条件は個別のポート法則に含めます。

`UseCase State Event Unit Input Output`のpostは入力・開始World・completion・終了Worldを受け取ります。Worldは状態と観測トレースです。ライブラリ自身がイベントを追加するため、ユースケースが呼出し順序を失うことを仕様に隠しません。この例では認可→commitの順序、成功応答前のcommit1回、最初の業務失敗の保存を要求します。核心の判断をポート法則へ移していません。

同じSystemContractを持つ各entryについて全completionのpostと不変条件保存を証明し、初期状態から任意有限回の**直列呼出し**へ接続します。ステップ関係は実装の全completionから生成し、安全な遷移だけを後から選別しません。初期集合の非空性と安全性も検査します。初期集合と本番initializerの接続は別途検証してください。

保証しないもの：pending await途中のクラッシュ、操作同士の並行interleaving、Promise/microtaskスケジューラ、進行性、アダプター実装自体。アダプターのrefinementは明示した外部仮定です。暗黙のtransaction・rollbackはありません。不変条件は操作完了境界での保証です。

初期対応構文：通常のasync関数、`const x = await port.method(pureInput)`、単独のawait、`return await helper(input)`、純粋なif、Result短絡、登録済み純粋helper、具体化されたasync helper。副作用を含む条件式・引数・三項式、未await呼出し、Promise変数、generator、try/catch/finally、ループは拒否します。`void`は`undefined`と同一視できないため、データとして扱いません。値を返さないポートは、実返値が`undefined`であることを明示した`Promise<undefined>`を使ってください。

テストは、認可削除・commit削除・順序逆転・二重実行を`unproved`として拒否します。有限シナリオのJavaScript結果とトレースについて、生成されたLean実行関係がそれらを許すことも検査します。これは変換器全体の等価性証明や業務成功の自動到達可能性証明ではありません。

```sh
npm run verify:ports
npm run typecheck:ports
```
