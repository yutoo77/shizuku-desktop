# Windowsでの自動検査

[Windows checks](../.github/workflows/windows-check.yml) は、GitHubの標準Windows x64環境とNode.js 24で、モデル不要の検査を行う。2026-09-10にリポジトリのPublic状態を確認してから、mainへのpushとmain向けpull requestでの自動実行を有効にした。手動実行も可能。

## 検査の範囲

1. `npm ci --no-audit --no-fund` でlockfileどおりに依存関係を導入する。
2. `npm run check` で型チェック、単体テスト、TypeScriptとWindows補助プログラムのBuildを行う。
3. `npm audit` で依存関係の既知の脆弱性を検査する。

VRM、`local.config.json`、APIキーは不要。Electronやブラウザーの実行ファイルを取得せず、アプリは起動しない。キャラクターの見た目、クリック透過、フォーカス、窓追従、実際のスリープ復帰、常駐時の負荷は、この検査では確認できない。[Windowsの実機検証](evaluation.md)とは結果を分けて扱う。

標準runnerの`windows-2025`を明示し、1 job・最大10分とする。同じbranchで新しい実行を始めると古い実行を中止する。Actionsは公式releaseのcommit SHAに固定し、リポジトリ権限は読み取りだけに絞る。認証情報をcheckout先に保存せず、追加のSecrets、キャッシュ、成果物のアップロード、定期実行は使わない。

2026-09-10には、会話のローカル試作を含むstage済みファイルを、ローカルWindowsの空の別フォルダに`git checkout-index`で展開し、同じコマンドとダウンロード抑止設定で検査した。対象tree ID（検査対象一式を識別するGitの値）は`b96e33ffdbe076cf9e6c2bdd0568d8035e7b2003`。Node.js 24.18.0 / npm 11.16.0で新規の依存関係導入、型チェック、65単体テスト、Buildが成功し、既知の脆弱性は0件だった。VRMが0件で、`local.config.json`とElectron実行ファイルがなくてもWindows補助プログラムをBuildできた。ローカル記録はGit対象外の`work/ci-final-cac8eb17/`に保存した。これは当該treeのローカル検証であり、GitHub runnerの実行結果や以後の変更の検証結果ではない。

この新規導入では、npmから`esbuild@0.28.2`のpostinstallが`allowScripts`未指定という警告が出た。インストールとBuildは成功したが、警告を消すためにスクリプトの許可範囲を広げる変更は行っていない。

## 公開後の実行と料金

Publicリポジトリで使う標準のGitHub-hosted runnerの実行は無料。このworkflowは標準の`windows-2025` x64を使用し、有料のlarger runner、成果物の保存、キャッシュは使わない。[GitHub公式の料金説明](https://docs.github.com/en/billing/concepts/product-billing/github-actions)

公開前はPrivateの残り無料枠をAPIで確認できなかったため手動設定に留め、GitHub側では実行していなかった。今回はPublic化の明示的な許可と公開状態の確認後に実行した。アカウント全体のプラン、予算、認証範囲は変更していない。今後Privateへ戻す場合やrunnerの種類を変える場合は、実行前に料金条件を確認する。最大10分という設定自体は無料の保証ではない。

手動で検査し直すときの手順：

1. 検査したい変更をpushする。mainへのpushでは自動実行されるため、同じ内容の手動実行を重ねる必要はない。
2. リポジトリの **Actions → Windows checks → Run workflow** を開く。
3. 検査したいbranchを選び、実行する。
4. 成否、commit SHA、所要時間を確認する。失敗時は原因を調べてから再実行する。

初回は`9bb3f07`の[Windows checks](https://github.com/yutoo77/shizuku-desktop/actions/runs/34444628787)が成功。標準Windows x64 / Node.js 24.20.0で、型チェック・65単体テスト・Buildが通り、`npm audit`は既知の脆弱性0件。ジョブの実行は34秒だった。最新の変更については[Actions一覧](https://github.com/yutoo77/shizuku-desktop/actions/workflows/windows-check.yml)で対象commitと成否を確認する。ローカルの成功や過去のCI成功だけで、以後の変更も成功したとは扱わない。

## 参照した公式資料

- [GitHub-hosted runners](https://docs.github.com/en/actions/reference/runners/github-hosted-runners): `windows-2025`は標準Windows x64 runner。
- [Windows Server 2025 runner image](https://github.com/actions/runner-images/blob/main/images/windows/Windows2025-Readme.md): 導入済みのWindows開発ツール。
- [actions/checkout v7.0.1](https://github.com/actions/checkout/releases/tag/v7.0.1): SHA `3d3c42e5aac5ba805825da76410c181273ba90b1`。
- [actions/setup-node v7.0.0](https://github.com/actions/setup-node/releases/tag/v7.0.0): SHA `820762786026740c76f36085b0efc47a31fe5020`。
- [workflow_dispatch](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#workflow_dispatch): 手動実行と既定branchの条件。
