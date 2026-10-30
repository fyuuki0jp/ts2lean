# 在庫予約ポリシー

`createReservationPolicy`へ予約上限と有効フラグを注入し、正の数量が在庫数・設定上限以下の場合だけ予約可能になることをLeanで検証します。

```sh
npm run build
npm run verify:inventory
```

`reserve`は判断ポリシーを関数ポートとして受け取り、`reserved {remaining}`または`rejected`を返します。Leanの`Decision`帰納型でタグとpayloadを保持し、`remainingStock`のvariant別の分岐も検証します。

このexampleは同期の予約判断です。永続化・競合・再試行は含みません。非同期DBポートのDIと障害・再試行の検証は[決済example](../payments/README.md)で扱います。

設定オブジェクトのフィールドを読む場合は現在値、factoryで分割代入した場合は取り込んだ値を検証前後に照合します。`readonly`だけを根拠に変更されないとは仮定しません。
