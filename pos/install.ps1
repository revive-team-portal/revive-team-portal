# One-shot installer: downloads the latest agent to C:\ScorecardAgent and registers
# it as a hidden background task that starts at logon and restarts itself.
[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
$dir = "C:\ScorecardAgent"
New-Item -ItemType Directory -Force -Path $dir | Out-Null
Invoke-WebRequest "https://team.revive.co.nz/pos/agent.ps1" -OutFile "$dir\agent.ps1" -UseBasicParsing
$a = New-ScheduledTaskAction -Execute "powershell.exe" -Argument "-ExecutionPolicy Bypass -WindowStyle Hidden -File `"$dir\agent.ps1`" -Token YOUR_POS_TOKEN"
$t = New-ScheduledTaskTrigger -AtLogOn
$s = New-ScheduledTaskSettingsSet -RestartInterval (New-TimeSpan -Minutes 2) -RestartCount 999 -ExecutionTimeLimit ([TimeSpan]::Zero) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
Register-ScheduledTask -TaskName "ScorecardPosAgent" -Action $a -Trigger $t -Settings $s -RunLevel Highest -Force | Out-Null
Start-ScheduledTask -TaskName "ScorecardPosAgent"
Write-Host ""
Write-Host "==> ScorecardPosAgent installed and started. You can close all windows now." -ForegroundColor Green
