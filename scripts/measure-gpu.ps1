param([int]$Samples = 60, [string]$Output = 'work/gpu.json')
$ErrorActionPreference = 'Stop'
$shizukuPids = Get-Content (Join-Path $PSScriptRoot '../work/pids.json') | ConvertFrom-Json
$results = [System.Collections.Generic.List[object]]::new()
Get-Counter '\GPU Engine(*)\Utilization Percentage' -SampleInterval 2 -MaxSamples $Samples -ErrorAction SilentlyContinue | ForEach-Object {
  $sample = $_
  $engines = @{}
  foreach ($counter in $sample.CounterSamples) {
    if ($counter.Status -in 0,1 -and $counter.InstanceName -match '^pid_(\d+)_(.+)$' -and [int]$matches[1] -in $shizukuPids) {
      $key = $matches[2]
      $engines[$key] = [double]$engines[$key] + [double]$counter.CookedValue
    }
  }
  $busiest = ($engines.Values | Measure-Object -Maximum).Maximum
  $results.Add([pscustomobject]@{time=$sample.Timestamp.ToUniversalTime().ToString('o'); available=($engines.Count -gt 0); busiestEnginePercent=$busiest; engines=$engines})
}
$results | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $Output -Encoding utf8
[pscustomobject]@{samples=$results.Count; mean=($results.busiestEnginePercent | Measure-Object -Average).Average; max=($results.busiestEnginePercent | Measure-Object -Maximum).Maximum} | ConvertTo-Json -Compress
