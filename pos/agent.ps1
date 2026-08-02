# Scorecard SwiftPOS probe agent. Read-only. Polls the portal for queued SELECT
# queries, runs them against the local SwiftPOS DB, and returns the results.
#   Trusted (Windows) auth:  powershell -ExecutionPolicy Bypass -File agent.ps1 -Token YOURTOKEN
#   Or SQL login:            ... -Token YOURTOKEN -User sa -Password xxxxx
param(
  [Parameter(Mandatory=$true)][string]$Token,
  [string]$Server = "127.0.0.1,50030",
  [string]$Db = "SWIFTPOS",
  [string]$User,
  [string]$Password
)
$base = "https://team.revive.co.nz/.netlify/functions/pos-agent"
if ($User) { $connStr = "Server=$Server;Database=$Db;User Id=$User;Password=$Password;TrustServerCertificate=True" }
else       { $connStr = "Server=$Server;Database=$Db;Integrated Security=SSPI;TrustServerCertificate=True" }
Write-Host "Scorecard agent started against $Server/$Db. Leave this window open. Ctrl+C to stop."
while ($true) {
  try {
    $n = Invoke-RestMethod -Uri "$base?action=next&k=$Token" -Method Get -TimeoutSec 25
    if ($n.job) {
      $id = $n.job.id; $sql = $n.job.sql
      Write-Host ("[{0}] job {1}" -f (Get-Date -Format HH:mm:ss), $id)
      if ($sql -notmatch '^(?is)\s*select') {
        Invoke-RestMethod -Uri "$base?action=result&k=$Token" -Method Post -ContentType 'application/json' -Body (@{id=$id;error='only SELECT queries are allowed'} | ConvertTo-Json) | Out-Null
      } else {
        try {
          $cn = New-Object System.Data.SqlClient.SqlConnection $connStr; $cn.Open()
          $cmd = $cn.CreateCommand(); $cmd.CommandText = $sql; $cmd.CommandTimeout = 180
          $rd = $cmd.ExecuteReader()
          $sb = New-Object System.Text.StringBuilder
          $cols = @(); for ($i=0; $i -lt $rd.FieldCount; $i++) { $cols += $rd.GetName($i) }
          [void]$sb.AppendLine(($cols -join "`t"))
          while ($rd.Read()) {
            $vals = @(); for ($i=0; $i -lt $rd.FieldCount; $i++) { $v = $rd.GetValue($i); $vals += ("" + $v) }
            [void]$sb.AppendLine(($vals -join "`t"))
          }
          $cn.Close()
          $out = $sb.ToString(); if ($out.Length -gt 850000) { $out = $out.Substring(0,850000) + "`n...truncated" }
          Invoke-RestMethod -Uri "$base?action=result&k=$Token" -Method Post -ContentType 'application/json' -Body (@{id=$id;result=$out} | ConvertTo-Json -Depth 3) | Out-Null
          Write-Host "   ok"
        } catch {
          Invoke-RestMethod -Uri "$base?action=result&k=$Token" -Method Post -ContentType 'application/json' -Body (@{id=$id;error=("" + $_)} | ConvertTo-Json) | Out-Null
          Write-Host "   error: $_"
        }
      }
    } else { Start-Sleep -Seconds 3 }
  } catch { Write-Host "poll error: $_"; Start-Sleep -Seconds 6 }
}
