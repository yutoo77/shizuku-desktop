# Windowsでの自動検査

[ワークフロー設定](../.github/workflows/windows-check.yml)は、`main`へのpush・Pull Request・手動実行で、標準のWindows x64 runnerを使う構成です。ソースのみを検査し、VRM・APIキー・VOICEVOXは要求しません。コードを公開しただけで、新しいリポジトリのCIが成功したことにはなりません。

## 検査すること

1. Node.js 24でlockfileに従い`npm ci`する。CIではElectron本体・Playwrightブラウザのダウンロードを抑える。
2. `npm run check`でTypeScript型検査、モデル不要の単体テスト、Windows補助を含むBuildを行う。
3. GPU計測補助のコンパイルだけを行い、GPU情報は取得しない。
4. `npm audit`で依存関係の既知の脆弱性を確認する。

ワークフローはモデルや外部AIへ接続せず、Electronの実画面も起動しません。`npm audit`の結果が0件でも未知の欠陥の不存在を意味しません。Windowsの実入力・VRM表示・VOICEVOX再生・常駐品質は、別途[実使用チェック](user-check.md)と[検証範囲](evaluation.md)で扱います。
