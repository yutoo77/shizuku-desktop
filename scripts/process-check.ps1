param([Parameter(Mandatory=$true)][string]$InputFile)
$ErrorActionPreference = 'Stop'
$taskIds = @(Get-Content -LiteralPath $InputFile -Raw | ConvertFrom-Json)
if ($taskIds.Count -eq 0 -or $taskIds.Count -gt 2048) { throw 'Invalid process identifier count' }
foreach ($taskId in $taskIds) {
    if ($taskId -isnot [long] -and $taskId -isnot [int]) { throw 'Process identifiers must be integers' }
    if ($taskId -le 0 -or $taskId -gt 4294967295) { throw 'Invalid process identifier' }
}
$taskResults = @()
# Bound each WMI query and restrict it to recorded process IDs. No command
# lines, window titles, user documents or unrelated process inventory is read.
for ($taskOffset = 0; $taskOffset -lt $taskIds.Count; $taskOffset += 64) {
    $taskLast = [Math]::Min($taskOffset + 63, $taskIds.Count - 1)
    $taskFilter = ($taskIds[$taskOffset..$taskLast] | ForEach-Object { 'ProcessId=' + [string]$_ }) -join ' OR '
    $taskProcesses = Get-CimInstance Win32_Process -Filter $taskFilter -Property ProcessId,ParentProcessId,Name,CreationDate
    foreach ($taskId in $taskIds[$taskOffset..$taskLast]) {
        # CIM can still list a terminated process object. Confirm kernel
        # liveness and creation time before using its parent metadata.
        try { $taskNative = [System.Diagnostics.Process]::GetProcessById([int]$taskId) }
        catch [System.ArgumentException] { continue }
        try {
            if ($taskNative.HasExited) { continue }
            $taskStarted = ([DateTimeOffset]$taskNative.StartTime).ToUnixTimeMilliseconds()
            $taskName = $taskNative.ProcessName + '.exe'
            $taskMetadata = $taskProcesses | Where-Object ProcessId -eq $taskId | Select-Object -First 1
            $taskParent = $null
            if ($null -ne $taskMetadata.CreationDate) {
                $taskCimStarted = ([DateTimeOffset]$taskMetadata.CreationDate).ToUnixTimeMilliseconds()
                if ($taskCimStarted -eq $taskStarted) { $taskParent = $taskMetadata.ParentProcessId }
            }
            if ($taskNative.HasExited) { continue }
            $taskResults += [pscustomobject]@{ pid = $taskId; parentPid = $taskParent; name = $taskName; creationTime = $taskStarted }
        } finally { $taskNative.Dispose() }
    }
}
ConvertTo-Json -InputObject @($taskResults) -Compress
