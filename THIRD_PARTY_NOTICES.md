# Third-Party Notices

このリポジトリで新規作成したソースコードには[MIT License](LICENSE)を適用します。ソースコード、依存ソフトウェア、VRMモデル、音声には、それぞれ別の利用条件が適用されます。このファイルとソースのMIT Licenseは、モデルや音声の権利を付与するものではありません。モデル・音声は同梱しません。

## 参照・再利用元

VRM の読み込み後の骨格最適化と腕の基本姿勢について、[adaptive-vrm-dialogue-agent の commit 445b0c7](https://github.com/yutoo77/adaptive-vrm-dialogue-agent/tree/445b0c7) の `frontend/src/vrm/modelLoader.ts` と `frontend/src/vrm/CharacterController.ts` を参照しました。既存ビューアー全体は移植せず、常駐表示用の小さな実装を新設しています。再利用元の MIT の著作権表示と許諾文を保持します。

小さな会話の試作では、同commitの`backend/app/character_profile.py`にある月白しずくの名前・一人称・控えめな返答方針と、既存BackendのOpenAI接続設定を参照しています。会話セッション・定型返答・main処理からのOpenAI Responses接続はこのアプリ用に作成し、既存のPython Backendを起動・移植していません。OpenAIのAPIは同社の利用条件と料金に従う外部サービスで、ソースのMIT Licenseに含まれません。

音声では既存アプリの`frontend/src/speech/SpeechClient.ts`と`LipSyncController.ts`の、音声と口形を分ける設計・音量に応じた口の動きを参照しました。ローカルVOICEVOXへの通信、音声の検証・破棄、デスクトップ側の口形更新はこのアプリ用に実装し、既存の会話・音声コード全体やPython Backendは移植していません。

```text
MIT License

Copyright (c) 2026 yutoo77

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## 主要な依存関係

以下は導入済みパッケージのライセンス表示を確認したものです。正確な依存バージョンと間接依存は `package-lock.json`、各ライセンス本文はインストールされたパッケージを参照してください。

| ソフトウェア | バージョン | ライセンス | 用途 |
| --- | --- | --- | --- |
| [Electron](https://github.com/electron/electron) | 44.3.0 | MIT | Windows ウィンドウ、通知領域、アプリの実行基盤 |
| [Three.js](https://github.com/mrdoob/three.js) | 0.185.1 | MIT | 3D 描画 |
| [@pixiv/three-vrm](https://github.com/pixiv/three-vrm) | 3.5.5 | MIT | VRM の読み込み、表情・骨格更新 |

Electron の配布物には Chromium・Node.js などの構成要素と、それぞれの第三者ライセンスが含まれます。将来アプリをパッケージ化する際は、実行本体に付属するライセンスと第三者通知を保持してください。開発ツールと間接依存にも各配布物の利用条件が適用されます。`node_modules/` とビルド結果の `dist/` は、このソースリポジトリの管理対象に含めません。

## 検証用 VRM

ローカル検証には AvatarSample_A を使用しています。しずく専用に作成した独自の外見ではなく、モデル本体は同梱・Git 管理しません。出典を自主的に記載します。

> AvatarSample_A © pixiv Inc. / pixiv VRoid Project

2026-09-09 に [公式 AvatarSample A〜Z 利用条件](https://vroid.pixiv.help/hc/ja/articles/4402394424089-AvatarSample-A-Z) を確認しました。対応アプリでのアバター利用と撮影した画像・動画の利用が例示されており、クレジット表記は不要とされています。ただし CC0 ではなく、CC0 としての設定や、内包データのキャラクター作成サービスへの流用、正当な理由のない有償再配布などは禁止されています。

この確認は今回のローカル表示と検証画像の用途についてのものです。モデル本体の再配布を今回の計画へ含めるものではありません。公開・配布方法を変える際は公式条件を再確認してください。利用者が別の VRM を選択する場合は、そのモデルの利用・改変・画像公開・再配布の条件を個別に確認します。

## 音声・その他の素材

任意の読み上げは、利用者が別に起動した標準VOICEVOXの冥鳴ひまり・ノーマル（スタイルID 14）を使います。音声クレジットは **VOICEVOX:冥鳴ひまり** で、会話窓の音声設定にも表示します。VOICEVOX本体、音声ライブラリ、生成音声、私的な録音は同梱せず、自動取得・自動起動も行いません。

2026-09-10に[VOICEVOXソフトウェア利用規約](https://voicevox.hiroshiba.jp/term/)と[VOICEVOX:冥鳴ひまりの利用規約](https://www.meimeihimari.com/terms-of-use)を確認しました。音声の利用には両方の条件とクレジット表記が適用されます。冥鳴ひまりの公式Q&Aはオリジナルキャラクターの声への利用を認めていますが、このアプリが音声やキャラクターの権利を取得する意味ではありません。音声を含む作品を公開する場合も、両規約を確認してクレジットを付けてください。ソースのMIT LicenseをVOICEVOXのソフトウェア・音声ライブラリ・生成音声へ適用しないでください。

エンジンAPIの接続方法と通常の合成の中止制限は[VOICEVOX Engine公式README](https://github.com/VOICEVOX/voicevox_engine)を参照しています。このアプリはHTTPで連携し、エンジンを組み込み・再配布していません。再配布の方法を変える場合は、ソフトウェアと音声ライブラリの条件を改めて確認してください。

Desktop Mate や市販 DLC のモデル・音声・台詞・固有設定は利用していません。通知領域の月のアイコンは、このアプリ内の図形処理で描画しています。
