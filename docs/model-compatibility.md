# 別モデルと選び直しの確認

モデルは利用条件を確認したローカルVRMを明示的に指定する。以下のコマンドは素材をダウンロードせず、普段のモデル選択や元ファイルを書き換えない。通常のしずくや他の計測を終了してから、1本ずつ実行する。

```powershell
npm run check
npm run test:model-selection
npm run test:model-compatibility -- --model 'C:\自分のモデル置き場\モデル.vrm'
```

`test:model-selection`は普段の設定からモデルの場所だけを読み、別の検査設定で使う。選択窓とファイル読み込みの返答を検査内で保留し、その間に隠す・休止と復帰・終了を行う。保存待ち中の非表示、遅れて届くエラー、取消後の選び直しも調べる。選択窓の実操作と、実際のPCのスリープ・ロックは行わない。

`test:model-compatibility`は指定したモデルについて、元の画質、省メモリ表示、座り姿と左右の向き、呼びかけ後の静止、非表示中のWebGL停止と復旧、元画質への復帰を確認する。WebGL停止は自アプリの描画面だけに発生させる。GPUドライバーの故障や実スリープの検査ではない。

記録と自アプリの画像はGit対象外の`work/model-selection-*/`と`work/model-compatibility-*/`に保存する。正常終了コード、プロセスの同一性を照合した残存確認、通常設定とモデルの一致を結果に残す。透明画素とモデルの画素が両方あることは自動で確認するが、姿勢・服・顔の見た目は保存した画像を別に評価する。

この短い互換性検査は、長時間の負荷や省メモリ効果の比較ではない。長めの同一モデルの測定は[常駐と会話の連続検査](daily-use.md)、画質変更の仕組みは[モデル画像の設定](texture-quality.md)を参照する。どちらのコマンドも外部AI・VOICEVOXを呼ばず、モデルを通常設定に採用しない。

## 追加サンプルの出典

2026-09-13、[pixiv/three-vrm公式のVRM1_Constraint_Twist_Sample](https://github.com/pixiv/three-vrm/blob/1b4fc0cc7ef39a49d62bb7a66dcfeca8f65316f7/packages/three-vrm/examples/models/VRM1_Constraint_Twist_Sample.vrm)を検査用に取得した。10,776,032 bytes、モデル内の版はv1.0.1、作者・著作権表示はpixiv Inc. / (c) 2022 pixiv Inc.。SHA-256は`12c2b97e95e700783a6a550dc0eee2d7880aeedccef9ae67bc4c5a2f0f2631a2`。

モデル内のライセンスURLは[VRMパブリック・ライセンス1.0](https://vrm.dev/licenses/1.0/)。同文書とファイル内の設定を確認した。アバター利用はeveryone、商用利用はcorporation、クレジットはunnecessary、再配布・改変は許可する設定で、反社会的・憎悪表現は禁止されている。今回はローカルの表示・描画復旧確認に限って使い、VRMや抽出画像を同梱・Git管理しない。ソースのMITをモデルへ適用しない。

普段のAvatarSample_Aとは別の技術検証用モデルで、しずく専用の外見として採用したものではない。検査結果は[検証記録](evaluation.md)へ残す。
