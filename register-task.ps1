# registers the AgentLink startup task (run from the repo root, no elevation needed for per-user tasks)
$root = $PSScriptRoot
$vbs = Join-Path $root "agentlink-bg.vbs"
$action = New-ScheduledTaskAction -Execute "wscript.exe" -Argument "`"$vbs`""
$trigger = New-ScheduledTaskTrigger -AtLogon
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
Register-ScheduledTask -TaskName "AgentLink" -Action $action -Trigger $trigger -Settings $settings -Force
Write-Host "AgentLink scheduled task registered."
