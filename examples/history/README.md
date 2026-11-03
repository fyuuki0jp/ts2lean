# GenericなUndo/Redoの検証

`history.ts`の`createHistory<T>`と`transitionHistory<T>`をそのまま取り込みます。証明用のreducerへ置き換えません。

```sh
npm run verify:history
npm run typecheck:history
```

`History.create`は実initializerが空のpast/futureと元のpresentを返すこと、`create_initial`はその結果が2つの状態機械の初期状態になることを示します。

`History.step`は上限80で、同じJSON観測を持つchangeと空のundo/redoが状態を保つこと、changeが最新の履歴を残すこと、undo/redoが元のpayloadと配列順序を保つことを指定します。`History.bounded`／`bounded50`は、それぞれ固定上限80／50での任意有限列について`past.length + future.length`の上限と各操作の安全性を証明します。`admissible`には実際の呼出し側が固定値を渡す条件を記述しています。利用側はこの条件と本番の呼出しを別途結び付けてください。

```ts
await expect(createHistory).toVerify(create);
await expect(transitionHistory).toVerify(step);
await expect(transitionHistory).toPreserveInvariant(bounded);
```

契約に`#ts2lean_snapshot_profile`を付けて、制限したデータ領域を明示します。

- `Ts2Lean.Snapshot`は不変payloadのidentityと実際の`JSON.stringify`観測を保持します。同じJSONを持つ別payloadを同一視しません。payloadの内部は不透明です。
- `Ts2Lean.SafeInteger`は`number`の安全な整数範囲と±0を表します。number演算や小数・NaN・Infinityのモデルではありません。これらを不透明payloadの内部に持つことは可能です。
- 配列は通常のdenseなreadonly配列で、標準のiterator・species・組込みメソッドを使います。hole、getter、Proxy、変更された組込み、外部からの変更は対象外です。
- `JSON.stringify`は副作用がなく、例外を投げず、同じpayloadで観測が安定することを前提にします。循環参照やthrowするserializerを一般に検証する機能ではありません。
- 配列長上限と添字範囲は証明義務です。TypeScriptの`!`で消すことはできません。メモリ枯渇はモデル化しません。

元の実装は上限0で`.slice(-0)`を実行すると履歴全体を保持します。これを切り捨て動作に近似せず、上限0の不変条件は`unproved`にします。履歴を反転する変更や誤ったpayloadを復元する変更も回帰テストで拒否します。
