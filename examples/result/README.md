# 本番のResultをそのまま検証する

`result.ts`は通常のTypeScriptの`Result<T, E>`と`ok`／`err`です。検証専用のタグやラッパー型をアプリへ追加しません。`main.ts`の本番関数をVitestへ渡します。

```sh
npm run verify:result
npm run typecheck:result
node dist/cli.js verify --config examples/result/ts2lean.config.ts
```

先に`Result.lean`へ要件を書き、その契約を満たすように`main.ts`を実装します。ここでは成功値、入力に応じたエラー、最初の失敗を保持する短絡を規定しています。

```lean
inductive Validation where
  | ok (value : Bool)
  | err (error : Problem)

#ts2lean_bool_union Validation "ok" Validation.ok Validation.err
```

この宣言をContent Mapperは次のTypeScript型へ変換します。`Problem`は同じファイル内の`kind`付きunionです。

```ts
type Validation =
  | { readonly ok: true; readonly value: boolean }
  | { readonly ok: false; readonly error: Problem };
```

commandの引数は順に「具体的なLean帰納型」「TSの判別フィールド名」「trueに対応するconstructor」「falseに対応するconstructor」です。constructor名からタグを推測しません。Lean型には型パラメータを持たせず、`Result<boolean, Problem>`には`Validation`、`Result<Success, Problem>`には`Outcome`、`Result<bigint, Problem>`には`NumberResult`を定義します。成功値・エラー値の両方に既存の`kind` unionをネストできます。

登録した型は中間処理でも使えます。たとえば`run`のcontractの出力が`Outcome`でも、中間関数`validate`は`Validation`を返せます。同じ構造には同じLean型を共有してください。

```ts
const step = validate(input);
if (!step.ok) return step;
return ok<Success>({ kind: "accepted", amount: input + 1n });
```

`ok`／`err`は実装を呼び出しごとに具体化して検証します。型引数の推論は、型変数を直接受け取る引数（`value: T`など）に対応します。`value: Box<T>`など複合型からの推論には明示型引数を指定してください。`Result<T, never>`の必須`never` payloadを持つvariantは到達不能として除外します。

genericな検証ルート、再帰、高階callbackによる`map`／`andThen`、generatorによる`sequence`は未対応です。関数宣言として同じファイルに存在する未使用helperは証明対象に含めません。実際に呼ぶ未対応処理は拒否します。exampleには未使用のoverload・generatorも併記し、Vite計装後の構文と実行結果を通常のテストで確認します。一般文字列の比較は別の拡張です。

`test/result.test.mjs`は成功値の改変、最初の失敗の置換・握りつぶし、条件の逆転を拒否し、JavaScriptとLeanの返値を比較します。これは変換器全体の形式証明ではありません。
