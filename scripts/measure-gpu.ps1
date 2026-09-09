param(
  [ValidateRange(2, 1800)][int]$Samples = 60,
  [string]$Output = 'work/gpu.json',
  [string]$PidsFile = (Join-Path $PSScriptRoot '../work/pids.json')
)
$ErrorActionPreference = 'Stop'
$shizukuPids = @(Get-Content -LiteralPath $PidsFile -Raw | ConvertFrom-Json)
if ($shizukuPids.Count -eq 0 -or @($shizukuPids | Where-Object { $_ -isnot [long] -and $_ -isnot [int] -or $_ -le 0 }).Count -gt 0) {
  throw 'PidsFile must contain an array of positive process IDs.'
}
$results = [System.Collections.Generic.List[object]]::new()
Get-Counter '\GPU Engine(*)\Utilization Percentage' -SampleInterval 2 -MaxSamples $Samples -ErrorAction SilentlyContinue | ForEach-Object {
  $sample = $_
  $engines = @{}
  $invalidCounters = 0
  foreach ($counter in $sample.CounterSamples) {
    if ($counter.InstanceName -match '^pid_(\d+)_(.+)$' -and [int]$matches[1] -in $shizukuPids) {
      $key = $matches[2]
      $value = [double]$counter.CookedValue
      if ($counter.Status -notin 0,1 -or -not [double]::IsFinite($value) -or $value -lt 0 -or $value -gt 100) {
        $invalidCounters++
        continue
      }
      $engines[$key] = [double]$engines[$key] + $value
    }
  }
  $busiest = ($engines.Values | Measure-Object -Maximum).Maximum
  $available = $engines.Count -gt 0 -and $invalidCounters -eq 0 -and $busiest -le 100
  $results.Add([pscustomobject]@{time=$sample.Timestamp.ToUniversalTime().ToString('o'); available=$available; invalidCounters=$invalidCounters; busiestEnginePercent=$busiest; engines=$engines})
}
$results | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $Output -Encoding utf8
$validSamples = @($results | Where-Object available)
[pscustomobject]@{samples=$results.Count; validSamples=$validSamples.Count; unavailableSamples=$results.Count-$validSamples.Count; mean=($validSamples.busiestEnginePercent | Measure-Object -Average).Average; max=($validSamples.busiestEnginePercent | Measure-Object -Maximum).Maximum} | ConvertTo-Json -Compress
