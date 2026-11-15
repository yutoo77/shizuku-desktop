# Compatibility entry point. Collection uses the bounded, console-free helper.
param(
  [ValidateRange(2, 1800)][int]$Samples = 60,
  [string]$Output = 'work/gpu.json',
  [string]$PidsFile = (Join-Path $PSScriptRoot '../work/pids.json')
)
$ErrorActionPreference = 'Stop'
& node (Join-Path $PSScriptRoot 'measure-gpu.mjs') --samples $Samples --pids-file $PidsFile --output $Output
exit $LASTEXITCODE
