# GitHub Packagesから使う

パッケージ名は`@fyuuki0jp/ts2lean`、レジストリは`https://npm.pkg.github.com`です。CLI名は`ts2lean`のままです。Node.js 22.18以上（推奨24）とLean 4.35.0が必要です。

新規プロジェクトへの導入はNode.js **24.22.1**とnpm **12.2.1**で確認しています。古いnpm（11.4.1では再現）でVitestのoptional peer解決が`edgesOut`エラーになる場合はnpmを更新してください。npm 12.2.1にはNode.js 22.22.2以上の22系、24.15.0以上の24系、または26以上が必要です。グローバル更新を避ける場合は`npx --yes npm@12.2.1 install ...`でも実行できます。

## ローカルでインストール

利用先リポジトリの`.npmrc`へ次を追加します。通常の依存はnpmjs.org、`@fyuuki0jp`だけGitHub Packagesから取得します。

```ini
@fyuuki0jp:registry=https://npm.pkg.github.com
```

初回だけ、`read:packages`権限のpersonal access token **classic**を使ってログインします。公開パッケージも認証が必要です。トークンはnpmの対話プロンプトに入力し、リポジトリには保存しません。[GitHub公式の認証手順](https://docs.github.com/en/packages/working-with-a-github-packages-registry/working-with-the-npm-registry#authenticating-to-github-packages)

```sh
npm login --scope=@fyuuki0jp --auth-type=legacy --registry=https://npm.pkg.github.com
npm install --save-dev @fyuuki0jp/ts2lean vitest@5.0.5 vite@8.3.5
```

開発版を使う場合は`npm install -D @fyuuki0jp/ts2lean@next`です。実際に導入したバージョンはlockfileへ保存してください。

Leanは[elan](https://github.com/leanprover/elan)で導入できます。

```sh
elan toolchain install leanprover/lean4:v4.35.0
```

elanの`lean`がPATHにあれば、ts2leanは生成作業ディレクトリの`lean-toolchain`から4.35.0を選びます。独自の実行ファイルを使う場合は`TS2LEAN_LEAN`を指定します。

`vitest.config.ts`:

```ts
import { defineConfig } from "vitest/config";
import { ts2lean } from "@fyuuki0jp/ts2lean/vite";
export default defineConfig({
  plugins: [ts2lean()],
  test: { testTimeout: 60_000 },
});
```

テストでは、通常の関数とLean契約を渡します。

```ts
import { expect, test } from "vitest";
import "@fyuuki0jp/ts2lean/vitest";
import { withdraw } from "./balance";
import { withdraw as contract } from "./Balance.lean";

test("残高の仕様を満たす", async () => {
  await expect(withdraw).toVerify(contract);
});
```

Lean importのエディタ・型検査にはContent Mapper対応TypeScriptが必要です。確認済みの版は`typescript@7.1.0-beta`です。通常のVitest実行用の解析器はパッケージの依存として同梱されます。

```json
{
  "compilerOptions": {
    "strict": true,
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "noEmit": true
  },
  "contentMappers": [
    { "package": "@fyuuki0jp/ts2lean", "extensions": [".lean"] }
  ]
}
```

```sh
npm install -D typescript@7.1.0-beta
npx tsc --runExternalCode --noEmit
npx vitest run
```

プラグインはNodeのテスト環境専用です。アプリのブラウザー用Vite設定とは分けてください。

## 別リポジトリのGitHub Actions

パッケージのSettings → **Manage Actions access**で利用先リポジトリにRead権限を付けます。利用先の`.npmrc`には上記scope設定を置き、workflowは以下のようにします。[GitHub公式のActionsアクセス設定](https://docs.github.com/en/packages/managing-github-packages-using-github-actions-workflows/publishing-and-installing-a-package-with-github-actions)

```yaml
permissions:
  contents: read
  packages: read
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: '24'
          cache: npm
          registry-url: https://npm.pkg.github.com
          scope: '@fyuuki0jp'
      - run: npm install --global npm@12.2.1
      - run: npm ci
        env:
          NODE_AUTH_TOKEN: ${{ secrets.GITHUB_TOKEN }}
      - name: Install Lean
        run: |
          curl --proto '=https' --tlsv1.2 -sSf https://raw.githubusercontent.com/leanprover/elan/master/elan-init.sh -o /tmp/elan-init.sh
          sh /tmp/elan-init.sh -y --no-modify-path --default-toolchain leanprover/lean4:v4.35.0
          echo "$HOME/.elan/bin" >> "$GITHUB_PATH"
      - run: npx vitest run
```

リポジトリの`GITHUB_TOKEN`にパッケージ権限を付与できない場合は、`read:packages`付きclassic PATを利用先のActions secretへ登録し、`NODE_AUTH_TOKEN`へ渡します。トークンをこのリポジトリやチャットへ貼る必要はありません。

## CDとバージョン

- `main`へのpush：全CI成功後、`0.1.0-dev.<run>.<attempt>.g<sha>`形式を`next`へ公開。
- `v0.1.0`などのタグ：`package.json`のversionとの一致を確認し、正式版を`latest`へ公開。
- pull request：検証のみ。公開権限は渡しません。
- 手動workflow実行：mainから実行すると新しい開発版を公開。

公開にはActionsの`GITHUB_TOKEN`を使うため、発行用のPATやnpmトークンの追加登録は不要です。テスト済みビルドをtarball artifactとして受け渡し、公開ジョブはそのtarballを公開します。公開後にレジストリから別ディレクトリへdevDependencyとしてインストールし、CLIとプラグインのロードを確認します。

正式版の更新は次の流れです。

```sh
npm version patch --no-git-tag-version
# package.jsonとpackage-lock.jsonをコミットしてmainへ反映
# 例: versionが0.1.1なら
git tag v0.1.1
git push origin v0.1.1
```

既存の公開バージョンは上書きしません。正式版の同じタグの再実行は、既に公開済みならpublishで停止します。新しい内容には新しいバージョンを付けてください。
