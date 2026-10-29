# ts2lean

TypeScriptの純粋関数とトランザクションを使う送金サービスをLean 4へ変換し、Leanで書いた事前条件・事後条件・不変条件をVitestから自動検証する実験的なライブラリです。対象関数とLean契約をテストで直接importして紐付けます。`bindings`を列挙する設定ファイルは不要です。

```ts
import { expect, test } from "vitest";
import "ts2lean/vitest";
import { withdraw } from "./balance";
import { withdraw as withdrawContract } from "./Balance.lean";

test("引き出し後も残高は非負で、指定額だけ減る", async () => {
  await expect(withdraw).toVerify(withdrawContract);
});
```

入力をサンプリングして実行するテストではなく、**事前条件を満たすすべての入力に対する証明**をLeanに検査させます。利用者が証明を書く必要はありません。解けない条件は未証明としてテストが失敗します。

## トランザクション・並行実行・復旧の検証

[決済基盤のドッグフーディング](examples/payments/README.md)では、SQLite上の口座・台帳・送金APIを実装しています。業務コードは通常のasync/awaitとDBトランザクションで書きます。

```ts
await expect({ transfer, retryPendingTransfers, recover })
  .toPreserveInvariant(ledgerInvariant);
```

実装から各コミットを抽出し、DBの外部保証を明示的な仮定として、任意有限回の並行実行・再試行・停止・復旧に対する安全性をLeanで証明します。`npm run test:payments`で証明・実DBテスト・不具合例を確認できます。現在は台帳専用の操作プロファイルであり、任意のTypeScriptやDBアダプター自体の検証ではありません。

## 開発環境で試す

Node.js 22.18以上とLean **4.35.0**を使います。Leanは[elan](https://github.com/leanprover/elan)で導入できます。`lean`がPATHにない場合は、`TS2LEAN_LEAN`に実行ファイルのパスを設定してください。開発用の`.tools/elan/bin/lean`も自動検出します。

```sh
npm ci
npm run build
npm run verify:example
npm test
```

`verify:example`は`examples/balance/balance.test.ts`をVitestで実行します。サンプルの減算を加算に変えるとテストが失敗し、Leanの診断と生成した証明ファイルのパスが表示されます。

## Vitestへの導入

利用するプロジェクトで`ts2lean`、`vitest`、`vite`をインストールし、`vitest.config.ts`でプラグインを有効にします。動作確認済みのバージョンはVitest **5.0.5**、Vite **8.3.5**です。

```ts
import { defineConfig } from "vitest/config";
import { ts2lean } from "ts2lean/vite";

export default defineConfig({
  plugins: [ts2lean()],
  test: { testTimeout: 60_000 },
});
```

```sh
npx vitest run
```

このプラグインはNode環境のテスト用です。ViteのrootをLeanモジュールの起点にします。異なる起点が必要なら`ts2lean({ root: "./src" })`と指定できます。`lean`、`leanPaths`、`timeoutMs`、`maxHeartbeats`もプラグインのオプションとして指定できます。関数ごとの対応付けはテストに置きます。

`import "ts2lean/vitest"`はmatcherを登録します。各テストに書くか、Vitestの`setupFiles`で読み込んでください。matcherは非同期なので必ず`await`します。

```ts
await expect(withdraw).toVerify(withdrawContract, {
  timeoutMs: 30_000,
  maxHeartbeats: 200_000,
});
```

`timeoutMs`はLeanの各プロセスの上限です。Vitestの`testTimeout`には、複数のLeanプロセスを起動する全体の時間を確保してください。証明失敗は反例の存在を意味しないため、`.not.toVerify()`は使用できません。

Viteで読み込んだ関数の元ファイルとexport名をプラグインが記録します。別名importでも動作します。mock、ラッパー、`.bind()`の戻り値、ソース読み込み後に対象・依存ファイルが変更された場合は検証を拒否します。関数の`toString()`から元コードを推測しません。検証開始時と成功を返す直前に依存関数の実参照も照合し、証明中のmock化を拒否します。成功後に関数や依存を変更した場合まで保証するものではありません。検証対象のソースを変換する独自プラグインは検証対象外です。

Vitestのmatcherを使わない場合は、同じプラグインで読み込んだ関数に対してランナー非依存のassertionも使えます。

```ts
import { verifyFunction } from "ts2lean";
await verifyFunction(withdraw, withdrawContract);
```

## 契約と実装

`balance.ts`は通常のTypeScriptです。検証ライブラリをimportする必要はありません。

```ts
export type WithdrawInput = {
  readonly balance: bigint;
  readonly amount: bigint;
};

export function withdraw(input: WithdrawInput): bigint {
  return input.balance - input.amount;
}
```

`Balance.lean`では、実装に依存せず仕様だけを記述します。

```lean
import Ts2Lean.Contract

namespace Balance
structure Input where
  balance : Int
  amount : Int

def invariant (balance : Int) : Prop := 0 ≤ balance

def withdraw : Ts2Lean.Contract Input Int where
  pre := fun i => invariant i.balance ∧ 0 ≤ i.amount ∧ i.amount ≤ i.balance
  post := fun i result => invariant result ∧ result = i.balance - i.amount
end Balance
```

Lean自身の型情報から、そのファイルに定義された公開`Ts2Lean.Contract`を自動検出します。名前空間を除いた名前がTypeScriptのexport名になります。同じ末尾名が複数あればエラーです。どの契約をどの関数に適用するかは、テストの`toVerify`呼び出しで決まります。1つの関数に複数の契約を適用することもできます。

## エディタとTypeScriptの型検査

Viteプラグインは実行時の`.lean` importを提供し、**Content Mapperは型検査とエディタ用の型情報**を提供します。TypeScript **7.1.0-beta**で確認しています。

```json
{
  "compilerOptions": {
    "strict": true,
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "verbatimModuleSyntax": true,
    "types": ["node"]
  },
  "contentMappers": [
    {
      "package": "ts2lean",
      "extensions": [".lean"]
    }
  ],
  "include": ["**/*.ts"]
}
```

```sh
tsc --runExternalCode --noEmit
```

Content Mapperも`bindings`なしで契約を自動検出します。Leanモジュールの起点は`tsconfig.json`のディレクトリです。追加のLeanソースディレクトリなどが必要なら、`contentMappers[].options`に`leanPaths`等の検証オプションを指定してください。Viteプラグインと同じLean環境を指定します。

`.lean`拡張子を明記してください。テストでは契約を値としてimportします。実装でLean由来の入力型を使いたい場合は、従来どおりtype importも使えます。

```ts
import type { withdraw } from "./Balance.lean";
type Input = withdraw["input"];
```

型情報はLeanの型検査から取得し、未保存のLean編集内容も反映します。`tsc`の成功は証明の成功を意味しません。通常の実装へのtype importはJavaScript出力から消えます。テスト内の契約の値importはViteプラグインで解決します。

## 検証エンジン

```text
importした関数 + importしたLean契約
  → 元TypeScriptの型検査 → 型付きIR → Leanモデルと証明義務
  → Leanのカーネル検査・公理監査 → Vitestの成功／失敗
```

AST解析・型検査には`@ts-morph/common` **0.28.1**に同梱されたTypeScript **5.9.2**のCompiler APIを使います。変換対象の構文もこのAPIで解析できる範囲に限ります。

生成したモデル・証明・IRはプロジェクトの`.ts2lean/run-*/`に保存します。元のコードや仕様は上書きしません。Lean検査は毎回独立した作業ディレクトリで行います。ルートの`Model.lean`、`Proof.lean`、`InspectContract.lean`は生成用の予約名です。独自Lake依存やmathlibの取得は初版の対象外です。

既存のCLI、`loadConfig`、`verify`、`extract`はバッチ検証用の互換APIとして残しています。Vitestからの検証に`ts2lean.config.ts`は不要です。

状態を持つ処理の制御フローは、[共通のcompletion意味論と包含証明](docs/semantics.md)でも検査します。try/catch/finally・再送出・awaitの失敗を保持し、変換した経路の欠落をLeanで検出します。

## 純粋関数の対応範囲

| 対応       | 内容                                                                                                |
| ---------- | --------------------------------------------------------------------------------------------------- |
| 値         | `bigint`、`boolean`、固定フィールドのreadonlyレコード、ネストしたレコード                           |
| 関数       | 名前付き関数、arrow、function式、静的に生成したクロージャ・サービスメソッド。データ引数は必須1個 |
| 式         | 整数リテラル、`+ - *`、大小比較、`=== !==`、`! && \|\|`、三項演算、フィールドアクセス、レコード生成 |
| 制御       | `const`・`let`、局所代入・`+= -= *=`・単独の`++ --`、分割代入、`if/else`、ブロック、早期return |
| モジュール | ローカル関数呼び出し、import alias、namespace import、barrel経由の再エクスポート、Leanへのtype import |
| DI         | module scopeのcomposition、関数ポート・オブジェクトポート、factoryが返す関数やサービス、`satisfies` |
| Lean型     | `Int`、`Bool`、型引数・継承・依存フィールドのないstructure                                          |

`number`演算、除算・剰余、文字列、配列、union、optional、`any`、型アサーション、ヒープ・プロパティ更新、式内の代入、`var`、ループ、再帰、例外、`async/await`、クラス、実行中の動的クロージャ生成、外部ライブラリ呼び出しは未対応として停止します。オブジェクトの同一性比較、getter、spread、computed property、`__proto__: value`も拒否します。レコード型は各フィールドに`readonly`を明記してください。構造が同じLeanレコードは同じ型を共有してください。

検証対象のモジュールと読み込まれる実装モジュールには、型宣言・import/export・関数・静的な依存の組立てだけを置きます。全module scopeを検査し、選択した入口から到達する関数本体を変換します。未使用の関数本体に対する保証は主張しません。

[アーキテクチャ別example](examples/architectures/README.md)では、レイヤード構成、クリーンアーキテクチャ、関数DI、局所変数を更新する実装を同じLean契約で検証します。`npm run test:architectures`で実行できます。DIの証明対象は具体的に注入した実装です。factory内は不変の依存の束縛と関数／サービスの返却に限定し、任意のDIコンテナ、decorator、クラスによるconstructor injection、実行時の依存選択、スカラー値のcaptureは未対応です。今回のDIと`let`拡張は純粋関数プロファイルが対象で、決済のeffectプロファイルにはまだ適用していません。

## 結果と保証の境界

| 結果                     | 意味                                                                 |
| ------------------------ | -------------------------------------------------------------------- |
| `verified`               | 生成モデルに対する定理をLeanが検査し、公理依存の監査も通過           |
| `extracted`              | モデルの生成・型検査のみ完了。証明済みではない                       |
| `unproved`               | 自動証明または証明の公理監査が失敗。反例が存在するという意味ではない |
| `unsupported`            | 変換対象外の構文・型を検出                                           |
| `type-error`             | TypeScript型エラー、または契約との型不一致                           |
| `spec-error`             | Lean仕様のエラー、仕様内の未許可公理など                             |
| `timeout` / `tool-error` | 時間上限、実行環境・ツールのエラー                                   |

Vitestの`toVerify`は`verified`だけを成功として扱い、それ以外はテストを失敗させます。既存CLIも、いずれかの対象が成功しなければ非ゼロで終了します。JSONは`{ "results": [...] }`形式です。各結果には`status`、`message`、対象の`module`と`export`、生成済みなら`artifact`が入り、成功した証明には`axioms`も入ります。

- 証明するのは`∀ input, pre input → post input (generatedFunction input)`です。不変条件は`pre`と`post`に含めます。事前条件そのものが充足可能であることは別の性質です。
- `sorryAx`や独自公理への依存を拒否します。Lean標準の`propext`、`Classical.choice`、`Quot.sound`だけを許可します。
- Vitestでは元の関数／クロージャの出所とexport bindingを別々に保持し、注入先・factory参照・実装moduleのソースを検証前後に照合します。依存オブジェクトのgetter・継承プロパティ・Proxyは拒否します。検証後の依存変更まで保証するものではありません。
- 変換器自体の正しさは形式証明していません。変換器とツールチェーンは信頼基盤であり、回帰テストとJavaScript／Leanの評価比較で確認しています。
- 呼び出し時の値は宣言された型を満たす必要があります。レコードは副作用のない通常のデータで、各フィールドがown propertyであり、getter・Proxy・外部からの変更を含まないことを前提とします。実行時の入力検証は提供しません。
- 検証は関数の値の意味を扱います。メモリ枯渇、実行時間、JavaScriptの最大bigintサイズなどの資源制約はモデル化しません。
- Lean仕様とTypeScript設定はローカルコードとして実行されます。悪意ある仕様を隔離するサンドボックスではありません。
- DBを使う操作は、別の`ledger-v1` effect検証経路で扱います。汎用I/O・任意の外部操作意味論は未対応です。[決済基盤のサンプル](examples/payments/README.md)に対応範囲と外部仮定を記載しています。

## テスト

`npm test`は、Vitestでの直接importによる紐付け、mock・ラッパー・古いソースの拒否、失敗時の終了コードに加えて、整数・分岐・スコープ・関数呼び出しの意味、未対応構文の拒否、仕様の不一致、誤った実装、公理・sorryの拒否、タイムアウト、TypeScript 7.1との実接続、型更新、import除去を確認します。

`.ts2lean/`は生成物だけなので削除できます。CIは固定したLeanとnpm lockfileを使用します。

参考: [h5i](https://github.com/h5i-dev/h5i)、[Content Mappersによる開発体験](https://zenn.dev/sora_kumo/articles/typescript7-content-mappers2)、[TypeScript Content Mapper実装](https://github.com/microsoft/typescript-go/tree/main/internal/contentmapper)。
