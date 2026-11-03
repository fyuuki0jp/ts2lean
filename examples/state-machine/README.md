# 実reducerの任意有限操作列を検証する

```ts
import {safety} from "./Machine.lean";
await expect(reduce).toPreserveInvariant(safety);
```

`reduce(state, add)`の本番実装をそのまま渡します。Leanの`StateMachine Input State`には、`state`射影・初期状態の述語・不変条件・初期集合が空でない証拠を書きます。`Input`の`state`フィールドは出力の`State`と同じ型にしてください。複数引数の関数では実際の引数名`state`に対応します。

生成証明は、契約の射影が実入力の`state`フィールドへの射影と定義的に等しいことを検査します。`state := fun _ => -1`等で到達可能な操作を消して保存則を空虚に証明する契約は拒否します。

生成された実装について初期状態の安全性・1回の遷移の保存を証明し、その**同じ実装**の遷移関係から任意有限列の保存を帰納法で導きます。独立した手書きのreducerモデルは必要ありません。到達不能な不安全状態は不変条件の前提の範囲外です。

初期集合の証拠は数学上の初期状態の存在を示すものです。アプリのinitializerを実行してその述語を満たすことは別の純粋関数契約で検証してください。現在のAPIはそのinitializerを自動接続しません。状態の同一性・ヒープalias・並行実行は対象外です。

```sh
npm run verify:state-machine
npm run typecheck:state-machine
```
