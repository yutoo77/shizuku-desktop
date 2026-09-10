# Windowsでの自動検査

[Windows checks](../.github/workflows/windows-check.yml) は、GitHubの標準Windows x64環境とNode.js 24で、モデル不要の検査を行う。初期設定は手動実行のみで、pushやPR作成では起動しない。

## 検査の範囲

1. `npm ci --no-audit --no-fund` でlockfileどおりに依存関係を導入する。
2. `npm run check` で型チェック、単体テスト、TypeScriptとWindows補助プログラムのBuildを行う。
3. `npm audit` で依存関係の既知の脆弱性を検査する。

VRM、`local.config.json`、APIキーは不要。Electronやブラウザーの実行ファイルを取得せず、アプリは起動しない。キャラクターの見た目、クリック透過、フォーカス、窓追従、実際のスリープ復帰、常駐時の負荷は、この検査では確認できない。[Windowsの実機検証](evaluation.md)とは結果を分けて扱う。

標準runnerの`windows-2025`を明示し、1 job・最大10分とする。同じbranchで新しい実行を始めると古い実行を中止する。Actionsは公式releaseのcommit SHAに固定し、リポジトリ権限は読み取りだけに絞る。認証情報をcheckout先に保存せず、追加のSecrets、キャッシュ、成果物のアップロード、定期実行は使わない。

2026-09-10には、会話のローカル試作を含むstage済みファイルを、ローカルWindowsの空の別フォルダに`git checkout-index`で展開し、同じコマンドとダウンロード抑止設定で検査した。対象tree ID（検査対象一式を識別するGitの値）は`b96e33ffdbe076cf9e6c2bdd0568d8035e7b2003`。Node.js 24.18.0 / npm 11.16.0で新規の依存関係導入、型チェック、65単体テスト、Buildが成功し、既知の脆弱性は0件だった。VRMが0件で、`local.config.json`とElectron実行ファイルがなくてもWindows補助プログラムをBuildできた。ローカル記録はGit対象外の`work/ci-final-cac8eb17/`に保存した。これは当該treeのローカル検証であり、GitHub runnerの実行結果や以後の変更の検証結果ではない。

この新規導入では、npmから`esbuild@0.28.2`のpostinstallが`allowScripts`未指定という警告が出た。インストールとBuildは成功したが、警告を消すためにスクリプトの許可範囲を広げる変更は行っていない。

## 初回の実行

PrivateリポジトリのActionsはアカウントの無料枠を使い、枠を超えると設定に応じて課金される。標準runnerでも無条件に無料ではない。[GitHub公式の料金説明](https://docs.github.com/en/billing/concepts/product-billing/github-actions)

2026-09-10の読み取り確認では、認証済みCLIからアカウントのプラン・残り無料枠を取得できなかった。利用量APIは`user`権限不足の404だったため、課金が止まる設定かどうかも未確認。認証範囲、支払い方法、予算設定は変更していない。最大10分という設定は実行時間の上限であり、無料枠を超えない保証ではない。

残り無料枠と超過利用の予算をGitHubの **Settings → Billing & licensing** で確認してから、次の手順で1回実行する。

1. このworkflowを既定branchの`main`にpushする。
2. リポジトリの **Actions → Windows checks → Run workflow** を開く。
3. 検査したいbranchを選び、実行する。
4. 成否、commit SHA、所要時間を確認する。失敗時は原因を調べてから再実行する。

GitHub側の実行成功が確認できてから、自動検査が通ったと記載する。ローカルの成功だけではGitHub runnerでの成功を意味しない。日常のpush/PR自動実行への切替は、利用枠と予算が確認できてから行う。

## 参照した公式資料

- [GitHub-hosted runners](https://docs.github.com/en/actions/reference/runners/github-hosted-runners): `windows-2025`は標準Windows x64 runner。
- [Windows Server 2025 runner image](https://github.com/actions/runner-images/blob/main/images/windows/Windows2025-Readme.md): 導入済みのWindows開発ツール。
- [actions/checkout v7.0.1](https://github.com/actions/checkout/releases/tag/v7.0.1): SHA `3d3c42e5aac5ba805825da76410c181273ba90b1`。
- [actions/setup-node v7.0.0](https://github.com/actions/setup-node/releases/tag/v7.0.0): SHA `820762786026740c76f36085b0efc47a31fe5020`。
- [workflow_dispatch](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#workflow_dispatch): 手動実行と既定branchの条件。
