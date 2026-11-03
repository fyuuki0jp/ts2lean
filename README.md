# ts2lean

TypeScriptの純粋関数とトランザクションを使う送金サービスをLean 4へ変換し、Leanで書いた事前条件・事後条件・不変条件をVitestから自動検証する実験的なライブラリです。対象関数とLean契約をテストで直接importして紐付けます。`bindings`を列挙する設定ファイルは不要です。

```ts
import { expect, test } from "vitest";
import "@fyuuki0jp/ts2lean/vitest";
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

## 別のリポジトリで使う

GitHub Packagesの`@fyuuki0jp/ts2lean`をdevDependencyに追加できます。利用先の`.npmrc`へ`@fyuuki0jp:registry=https://npm.pkg.github.com`を設定し、初回だけ`read:packages`付きclassic PATでログインしてください。

```sh
npm login --scope=@fyuuki0jp --auth-type=legacy --registry=https://npm.pkg.github.com
npm install -D @fyuuki0jp/ts2lean vitest@5.0.5 vite@8.3.5
```

`main`更新時は開発版を`next`へ、バージョンタグは正式版を`latest`へ、CI成功後に自動公開します。[導入・Lean設定・別repoのActions・リリース手順](docs/github-packages.md)に設定例をまとめています。

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

利用するプロジェクトで`@fyuuki0jp/ts2lean`、`vitest`、`vite`をインストールし、`vitest.config.ts`でプラグインを有効にします。動作確認済みのバージョンはVitest **5.0.5**、Vite **8.3.5**です。

```ts
import { defineConfig } from "vitest/config";
import { ts2lean } from "@fyuuki0jp/ts2lean/vite";

export default defineConfig({
  plugins: [ts2lean()],
  test: { testTimeout: 60_000 },
});
```

```sh
npx vitest run
```

このプラグインはNode環境のテスト用です。ViteのrootをLeanモジュールの起点にします。異なる起点が必要なら`ts2lean({ root: "./src" })`と指定できます。`lean`、`leanPaths`、`timeoutMs`、`maxHeartbeats`もプラグインのオプションとして指定できます。関数ごとの対応付けはテストに置きます。

`import "@fyuuki0jp/ts2lean/vitest"`はmatcherを登録します。各テストに書くか、Vitestの`setupFiles`で読み込んでください。matcherは非同期なので必ず`await`します。

```ts
await expect(withdraw).toVerify(withdrawContract, {
  timeoutMs: 30_000,
  maxHeartbeats: 200_000,
});
```

`timeoutMs`はLeanの各プロセスの上限です。Vitestの`testTimeout`には、複数のLeanプロセスを起動する全体の時間を確保してください。証明失敗は反例の存在を意味しないため、`.not.toVerify()`は使用できません。

`toVerify`の対象は渡された関数オブジェクトです。Viteプラグインは関数の生成時に、変換前のソース・型依存・import解決結果のスナップショットと、実際の捕捉値・依存関数を読み取る処理を紐付けます。未exportのclosureやラッパーも検証でき、同じコードから作った関数でも捕捉値が違えば別のモデルになります。読み込み後にファイルを編集・削除しても、保持している関数は生成時のソースで検証します。旧版と新版の関数を一緒に渡すこともできます。

依存を別の登録済み関数へ差し替えると、現在の実関数を解析します。未登録のmockや`.bind()`の戻り値は対応するモデルがないため拒否します。一般のmockへ契約を仮定として付与するAPIは未対応です。証明で利用した依存・捕捉値・DB handleを検証前後に照合し、証明中の変更を拒否します。成功後の変更まで保証するものではありません。

`magic-string`の役割は、この登録コードを挿入してソースマップを維持することです。差分検出や証明は行いません。関数の`toString()`から元コードを推測せず、ファイル名は生成元ノードと型情報を特定するためにだけ利用します。検証対象のソースを変換する独自プラグインは検証対象外です。

Vitestのmatcherを使わない場合は、同じプラグインで読み込んだ関数に対してランナー非依存のassertionも使えます。

```ts
import { verifyFunction } from "@fyuuki0jp/ts2lean";
await verifyFunction(withdraw, withdrawContract);
```

## Reactの状態遷移を検証する

[決済exampleのReact画面](examples/payments/README.md#react画面と実際のreducerの検証)は、実際に`useReducer`へ渡す`paymentReducer(state, action)`をLean契約で検証します。`npm run dev:payments`で画面を起動し、`npm run verify:payments-ui`で証明を実行できます。

複数の必須データ引数は、**引数名をフィールド名にしたLean入力structure**へ対応付けます。例えば`(state: State, action: Action) => State`なら、契約の入力に`state : State`と`action : Action`を定義します。内部の関数呼び出しでは宣言順に引数を対応付けます。単一引数の契約は従来どおりです。複数引数の分割代入・default・optional・rest・明示的な`this`引数は未対応です。

TypeScriptの関数型から引数名は取得できないため、複数引数のmatcher型は返値型を検査し、引数名と入力型の対応は検証時のコンパイラが検査します。Reactコンポーネントは通常のTSX、検証するreducerは`.ts`に置きます。JSX・Hooks・Reactの実行全体を形式検証する機能ではありません。

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
      "package": "@fyuuki0jp/ts2lean",
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

0.1.1から`src/features/edit-routine/model/Access.lean`のようなkebab-caseのパスにも対応しています。契約を所有モジュール内に置いたまま、リポジトリrootの単一設定から通常の相対importで使えます。Lean同士のimportは`import src.features.«edit-routine».model.Access`と書きます。[パスの対応範囲と構文拡張の計画](docs/semantics.md)を参照してください。

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

AST解析・型検査にはTypeScript **7.1.0-beta**のnative API（`typescript/sync`・`typescript/ast`）を使います。検証済みのLean型定義は仮想ファイルとして渡し、解析終了時にnativeセッションを解放します。TypeScriptは実行時依存として配布し、Viteのソース書換えに使う`magic-string`は開発依存としてプラグインへbundleします。

`npm run test:package`は配布用tarballを一時ディレクトリへ本番依存だけでインストールし、CLI・native compiler・Viteの変換を確認します。さらに外部プロジェクトのdevDependencyとして導入し、kebab-caseの所有モジュール間のLean依存、Content Mapperの型検査、Vitestの実証明を確認します。

生成したモデル・証明・IRはプロジェクトの`.ts2lean/run-*/`に保存します。元のコードや仕様は上書きしません。Lean検査は毎回独立した作業ディレクトリで行います。ルートの`Model.lean`、`Proof.lean`、`InspectContract.lean`は生成用の予約名です。独自Lake依存やmathlibの取得は初版の対象外です。

既存のCLI、`loadConfig`、`verify`、`extract`はバッチ検証用の互換APIとして残しています。Vitestからの検証に`ts2lean.config.ts`は不要です。

状態を持つ処理の制御フローは、[共通のcompletion意味論と包含証明](docs/semantics.md)でも検査します。try/catch/finally・再送出・awaitの失敗を保持し、変換した経路の欠落をLeanで検出します。

## 純粋関数の対応範囲

| 対応       | 内容                                                                                                |
| ---------- | --------------------------------------------------------------------------------------------------- |
| 値         | `bigint`、`boolean`、固定フィールドのreadonlyレコード、ネストしたレコード、`kind`タグの判別可能union |
| 関数       | 名前付き関数、arrow、function式、クロージャ・サービスメソッド。データ引数は必須1個以上（複数時は単純な引数名が必要） |
| 式         | 整数リテラル、`+ - *`、大小比較、`=== !==`、`! && \|\|`、三項演算、フィールドアクセス、レコード生成 |
| 制御       | `const`・`let`、局所代入・`+= -= *=`・単独の`++ --`、分割代入、`if/else`、ブロック、早期return |
| モジュール | ローカル関数呼び出し、import alias、namespace import、barrel経由の再エクスポート、Leanへのtype import |
| DI         | module scopeのcomposition、関数ポート・オブジェクトポート、factoryが返す関数やサービス、`satisfies` |
| Lean型     | `Int`、`Bool`、型引数・継承・依存フィールドのないstructure、非再帰のinductive union                                          |

`number`演算、除算・剰余、一般の文字列、配列、非判別union、optional、`any`、型アサーション、ヒープ・プロパティ更新、式内の代入、`var`、ループ、再帰、例外、`async/await`、クラス、実行中の動的クロージャ生成、外部ライブラリ呼び出しは未対応として停止します。オブジェクトの同一性比較、getter、spread、computed property、`__proto__: value`も拒否します。レコード型は各フィールドに`readonly`を明記してください。構造が同じLeanレコードは同じ型を共有してください。

`toVerify`では渡された関数と実際に参照する依存関数の本体を変換します。factoryや無関係なmodule初期化を静的に再実行する必要はありません。CLIのファイル指定検証は静的なcompositionを解析するため、従来どおりmodule scopeを型宣言・import/export・関数・静的な依存の組立てに限定します。未使用の関数本体に対する保証は主張しません。

[アーキテクチャ別example](examples/architectures/README.md)では、レイヤード構成、クリーンアーキテクチャ、関数DI、局所変数を更新する実装を同じLean契約で検証します。`npm run test:architectures`で実行できます。DIの証明対象は具体的に注入した実装です。`toVerify`は生成済みの関数を検証するため、factory自体の実行方法に依存しません。CLIの静的compositionではfactory内を不変の依存の束縛と関数／サービスの返却に限定します。decorator・クラスによるconstructor injectionは未対応です。bigint・booleanのliteral、const alias、factory引数、設定オブジェクトのフィールドのcaptureに対応し、実際の値を検証前後に照合します。決済のeffectプロファイルも、同期factoryが返すasync関数・サービスへのDB／非同期helperの注入に対応します。effect側の可変局所変数・scalar captureは未対応です。

判別可能unionは`readonly kind: "tag"`を持つrecordの和で表し、Leanの非再帰・非依存なinductiveのconstructor名をタグ、名前付き引数をpayloadに対応させます。`if`・三項演算のタグ比較で変数を絞り込みます。判別フィールド名の変更（`kind`以外）、`switch`、unionの動的キャストは未対応です。[在庫予約example](examples/inventory/README.md)では設定値DI・関数DI・成功／拒否のunionを組み合わせています。

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
- Vitestでは関数インスタンスごとに生成時のソースを保持し、モデルが利用した実依存・捕捉値を検証前後に照合します。現在のexport binding、factory参照、ディスク上のソースとの一致は条件にしません。依存オブジェクトのgetter・継承プロパティ・Proxyは拒否します。検証後の依存変更まで保証するものではありません。
- 変換器自体の正しさは形式証明していません。変換器とツールチェーンは信頼基盤であり、回帰テストとJavaScript／Leanの評価比較で確認しています。
- 呼び出し時の値は宣言された型を満たす必要があります。レコードは副作用のない通常のデータで、各フィールドがown propertyであり、getter・Proxy・外部からの変更を含まないことを前提とします。実行時の入力検証は提供しません。
- 検証は関数の値の意味を扱います。メモリ枯渇、実行時間、JavaScriptの最大bigintサイズなどの資源制約はモデル化しません。
- Lean仕様とTypeScript設定はローカルコードとして実行されます。悪意ある仕様を隔離するサンドボックスではありません。
- DBを使う操作は、別の`ledger-v1` effect検証経路で扱います。汎用I/O・任意の外部操作意味論は未対応です。[決済基盤のサンプル](examples/payments/README.md)に対応範囲と外部仮定を記載しています。

## テスト

`npm test`は、Vitestでの関数インスタンスへの紐付け、未exportのclosure・ラッパー・旧ソースの検証、未登録mockの拒否、失敗時の終了コードに加えて、整数・分岐・スコープ・関数呼び出しの意味、未対応構文の拒否、仕様の不一致、誤った実装、公理・sorryの拒否、タイムアウト、TypeScript 7.1との実接続、型更新、import除去を確認します。

`npm run test:differential`は再帰的に生成した式・union・非同期DIと障害をJavaScript／Leanで比較します。seed固定、ケース保存、replay、整数入力の縮小、演算子・操作順序の意図的破壊の検出を備えます。[差分テストの範囲と実行方法](docs/differential-testing.md)を参照してください。

`.ts2lean/`は生成物だけなので削除できます。CIは固定したLeanとnpm lockfileを使用します。

参考: [h5i](https://github.com/h5i-dev/h5i)、[Content Mappersによる開発体験](https://zenn.dev/sora_kumo/articles/typescript7-content-mappers2)、[TypeScript Content Mapper実装](https://github.com/microsoft/typescript-go/tree/main/internal/contentmapper)。
