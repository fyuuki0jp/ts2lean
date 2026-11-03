# アーキテクチャをまたぐ検証

同じ見積り契約 `result = max(0, amount - discount)` を、構造の異なる実装へ適用します。金額と割引額は非負のbigintです。

```sh
npm run test:architectures
```

| ディレクトリ | 構造 | 確認する内容 |
| --- | --- | --- |
| `layered/` | presentation → application → domain | モジュール分割、barrelの再エクスポート、namespace import、引数・局所変数の分割代入 |
| `clean/` | composition rootでcontroller、use case、pricing adapterを組み立てる | interfaceで定義したポート、factoryへの依存注入、サービスメソッド、複数段のクロージャ |
| `function-di/` | 関数をfactoryへ直接注入する | 同一factoryの異なるインスタンスを区別し、誤った注入先を証明しない |
| `imperative/` | 局所的なlet更新と条件分岐 | 代入後の値を分岐の合流後まで保持する |

`clean/application/quote.ts`は具体的なadapterをimportせず、`PricingPort`に依存します。`clean/composition.ts`で実装を接続します。

```ts
export const useCase = createQuoteUseCase(pricing);
export const handle = createController(useCase);
```

テストは通常の関数をimportして検証します。返されたサービスのメソッドも対象にできます。

```ts
await expect(handle).toVerify(nonnegativeQuote);
await expect(useCase.execute).toVerify(nonnegativeQuote);
```

コンパイラはfactoryをJavaScriptとして実行せず、ASTとTypeScriptのsymbolから配線を解決します。注入先ごとに一階のLean関数へ展開し、ドメイン実装まで含めて証明します。任意の実装がinterfaceを満たすだけで契約を保証されるわけではありません。`function-di/wrong`は実行可能な型ですが、同じLean契約の証明は失敗します。

Vitestでは実際のクロージャに生成時のソースと型情報を紐付け、現在のポート関数と捕捉値から検証モデルを作ります。factory参照や現在のファイルとの一致は要求しません。未登録mock、検証中の差し替え、getter、Proxyの拒否はライブラリ側の回帰テストで確認します。

## 対応境界

このexampleは同期・純粋な関数のDIを扱います。CLIでも解析できるよう、factory内はconstによる依存の束縛と関数／サービスの返却に限定しています。`toVerify`は生成済みの関数を検証するため、生成前の依存選択やfactoryの静的評価は不要です。一般的なclassのconstructor injection、decorator、検証対象の本体内での動的な依存選択、可変ヒープへの書込み、任意の外部I/Oは未対応です。非同期DBポートのDIは[決済example](../payments/README.md)を参照してください。

局所変数の代入は対応しますが、オブジェクトの更新、配列、ループ、式の途中にある`x++`などは拒否します。変換器自体の形式検証ではなく、生成Leanモデルの証明とJavaScriptとの比較テストを組み合わせています。
