# Scorecard SwiftPOS probe agent (read-only). Polls the portal for queued SELECT
# queries, runs them against the local SwiftPOS DB, returns the results.
#   powershell -ExecutionPolicy Bypass -File agent.ps1 -Token YOURTOKEN
#   (add -User sa -Password xxxxx if Windows auth fails)
param(
  [Parameter(Mandatory=$true)][string]$Token,
  [string]$Server = "127.0.0.1,50030",
  [string]$Database = "SWIFTPOS",
  [string]$User,
  [string]$Password
)
# Force TLS 1.2 (Windows PowerShell 5.1 otherwise fails the HTTPS handshake)
try { [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12 } catch {}
$base = "https://team.revive.co.nz/.netlify/functions/pos-agent"
$logUrl = "https://team.revive.co.nz/.netlify/functions/pos-paste"
$nextUrl = $base + "?action=next&k=" + $Token
$resultUrl = $base + "?action=result&k=" + $Token
if ($User) { $connStr = "Server=$Server;Database=$Database;User Id=$User;Password=$Password;TrustServerCertificate=True" }
else       { $connStr = "Server=$Server;Database=$Database;Integrated Security=SSPI;TrustServerCertificate=True" }
function Log($m){
  Write-Host $m
  try { Invoke-RestMethod -Uri $logUrl -Method Post -ContentType 'application/json' -Body (@{label='agent';content=$m} | ConvertTo-Json) -TimeoutSec 15 | Out-Null } catch {}
}
Log ("next url = " + $nextUrl)
Log "agent starting - server=$Server db=$Database auth=$(if($User){'sql:'+$User}else{'windows'})"
# connectivity + DB self-test
try {
  $t = Invoke-RestMethod -Uri $nextUrl -Method Get -TimeoutSec 25
  Log "http ok - reached portal"
} catch { Log "HTTP FAILED: $_"; }
try {
  $cn = New-Object System.Data.SqlClient.SqlConnection $connStr; $cn.Open()
  $cm = $cn.CreateCommand(); $cm.CommandText = "SELECT 1"; [void]$cm.ExecuteScalar(); $cn.Close()
  Log "db ok - connected to SwiftPOS"
} catch { Log "DB FAILED: $_ (try re-running with -User sa -Password <sa password>)" }
Log "polling for jobs... (leave this window open)"
while ($true) {
  try {
    $n = Invoke-RestMethod -Uri $nextUrl -Method Get -TimeoutSec 25
    if ($n.job) {
      $id = $n.job.id; $sql = $n.job.sql
      if ($sql -notmatch '^(?is)\s*select') {
        Invoke-RestMethod -Uri $resultUrl -Method Post -ContentType 'application/json' -Body (@{id=$id;error='only SELECT allowed'} | ConvertTo-Json) | Out-Null
      } else {
        try {
          $cn = New-Object System.Data.SqlClient.SqlConnection $connStr; $cn.Open()
          $cmd = $cn.CreateCommand(); $cmd.CommandText = $sql; $cmd.CommandTimeout = 180
          $rd = $cmd.ExecuteReader(); $sb = New-Object System.Text.StringBuilder
          $cols=@(); for($i=0;$i-lt$rd.FieldCount;$i++){$cols+=$rd.GetName($i)}; [void]$sb.AppendLine(($cols -join "`t"))
          while($rd.Read()){ $vals=@(); for($i=0;$i-lt$rd.FieldCount;$i++){$vals+=(""+$rd.GetValue($i))}; [void]$sb.AppendLine(($vals -join "`t")) }
          $cn.Close(); $out=$sb.ToString(); if($out.Length -gt 850000){$out=$out.Substring(0,850000)+"`n...truncated"}
          Invoke-RestMethod -Uri $resultUrl -Method Post -ContentType 'application/json' -Body (@{id=$id;result=$out} | ConvertTo-Json -Depth 3) | Out-Null
          Log "job $id done"
        } catch { Invoke-RestMethod -Uri $resultUrl -Method Post -ContentType 'application/json' -Body (@{id=$id;error=(""+$_)} | ConvertTo-Json) | Out-Null; Log "job $id ERROR: $_" }
      }
    } else { Start-Sleep -Seconds 3 }
  } catch { Log "poll error: $_"; Start-Sleep -Seconds 6 }
}
