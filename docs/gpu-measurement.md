# GPU計測と終了の確認

開発環境のWindowsで、通常のしずくを終了してから1本ずつ実行する。新しい計測補助はC#とWindows標準のPDH（処理負荷を読むAPI）を使う。既存の.NET Frameworkコンパイラーで検査用フォルダ内に作り、通常のアプリ起動や配布用distへは追加しない。追加契約・ダウンロード・外部通信、Windowsの設定変更はない。

```powershell
npm run check
npm run test:gpu
$env:SHIZUKU_DAILY_DRY_RUN_SECONDS = '30'
npm run test:daily-use
Remove-Item Env:SHIZUKU_DAILY_DRY_RUN_SECONDS
```

`test:gpu`はモデルなしで、対象カウンターがない場合、対象プロセスがない場合、中止、検査用の親プロセスだけが終了する場合を確かめる。実GPU値とモデル表示の検査には、選択済みのローカルVRMを使う`test:daily-use`が必要。動く表示との違いは`test:resident`でも確認できる。これらはアプリ内部の操作による検査で、実マウス・キー・IME・スリープの代わりにはならない。

既に記録した自アプリのPIDを使う単独採取は次のとおり。

```powershell
node scripts/measure-gpu.mjs --samples 60 --pids-file work/pids.json --output work/gpu.json
```

PIDファイルは整数の配列。再起動後の古いPIDは使わない。既存の`measure-gpu.ps1`も新しいNodeの入口を呼ぶ互換コマンドとして残している。CIの`--build-only`はコンパイルだけで、GPUやモデルを使わない。

取得では[言語に依存しないカウンター追加](https://learn.microsoft.com/en-us/windows/win32/api/pdh/nf-pdh-pdhaddenglishcounterw)と[配列による値の取得](https://learn.microsoft.com/en-us/windows/win32/api/pdh/nf-pdh-pdhgetformattedcounterarrayw)を使う。最初の値を準備してから約2秒ごとに採取し、指定PIDと開始時刻が一致するプロセスだけを対象にする。他アプリのGPU値は出力せず、窓の名前・内容・入力を取得しない。最も忙しいGPU処理系の利用率であり、GPUメモリの量ではない。

生のPDH時刻は今回の環境でUTCとの差があったため、そのまま文字列で保存し、集計には取得呼出し前後のUTC実測時刻を使う。前の呼出し開始から今回の完了までが同じ計測区間へ完全に収まる値だけを集計する。境界にまたがる値、途中で対象が変わった値、欠測・無効値を0%へ置き換えない。これは取得時刻の範囲による照合で、GPU処理一つ一つの実行時刻を測ったものではない。

出力の配列に加え、`gpu.json.metadata.json`へ完了状態・有効数・補助の終了確認を保存する。`status: completed`と有効標本数を両方確認する。中止・失敗・時間切れの途中値は保持するが、正常終了した集計へ混ぜない。`gpu-worker-*`内の段階記録で、追加・初期取得・採取・終了のどこまで進んだか分かる。

補助はコンソールを作らず、親の終了も監視する。通常の中止は専用ファイルで伝え、取得ハンドルを閉じる。OSの取得が止まった場合に備え、補助内とNode側に「指定標本数×2秒＋約10秒」の期限を設ける。強制終了や終了を確認できない場合は失敗にする。別プロセスを探して一括終了する処理はない。実GPUドライバーを故障させた検査は行わない。

画像・生データ・バイナリーは`work/`内のGit対象外へ置く。[実施結果と制限](evaluation.md)を参照する。
