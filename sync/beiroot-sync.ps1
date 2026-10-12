# Beiroot Sync: sends Aronium's end-of-day (Z) reports to the Beiroot stock system.
# Runs every 5 minutes from a Windows scheduled task (see install.ps1).
# It only READS Aronium's database. It never changes anything in Aronium.
# Works with Windows PowerShell 5.1 (built into Windows 10/11). Nothing to download.
param([switch]$Check)

$ErrorActionPreference = 'Stop'
$Version = '1.0.0'
$Here = Split-Path -Parent $MyInvocation.MyCommand.Path
$ConfigPath = Join-Path $Here 'config.json'
$StatePath = Join-Path $Here 'state.json'
$LogPath = Join-Path $Here 'sync.log'
$ProductsEveryHours = 6
$MaxReportsPerRun = 20

function Write-Log([string]$msg) {
  try {
    if ((Test-Path $LogPath) -and (Get-Item $LogPath).Length -gt 1MB) {
      Move-Item -Force $LogPath ($LogPath + '.1')
    }
    Add-Content -Path $LogPath -Value ((Get-Date -Format 'yyyy-MM-dd HH:mm:ss') + '  ' + $msg) -Encoding UTF8
  } catch { }
  if ($Check) { Write-Host $msg }
}

function Read-Json([string]$path) {
  if (-not (Test-Path $path)) { return $null }
  return (Get-Content -Raw -Encoding UTF8 $path | ConvertFrom-Json)
}

function Save-State($state) {
  $tmp = $StatePath + '.tmp'
  ($state | ConvertTo-Json -Depth 4) | Set-Content -Path $tmp -Encoding UTF8
  Move-Item -Force $tmp $StatePath
}

# ---------- Reading Aronium's database (read-only) ----------

$script:conn = $null
function Open-Aronium($cfg) {
  if ($env:BEIROOT_SYNC_TEST_QUERY) { return }   # test harness only: queries go to a stand-in reader
  if (-not (Test-Path $cfg.dbPath)) { throw "Aronium database not found at $($cfg.dbPath)" }
  if (-not (Test-Path $cfg.sqliteDll)) { throw "Aronium's SQLite reader not found at $($cfg.sqliteDll)" }
  Add-Type -Path $cfg.sqliteDll
  $cs = "Data Source=$($cfg.dbPath);Version=3;Read Only=True;FailIfMissing=True;Default Timeout=15;Pooling=False"
  $script:conn = New-Object System.Data.SQLite.SQLiteConnection($cs)
  $script:conn.Open()
}

function Close-Aronium {
  if ($script:conn) { try { $script:conn.Close(); $script:conn.Dispose() } catch { } ; $script:conn = $null }
}

# Runs one query and returns rows as objects. Only numbers we control are ever put into the SQL.
function Invoke-Query([string]$sql) {
  $rows = New-Object System.Collections.ArrayList
  if ($env:BEIROOT_SYNC_TEST_QUERY) {
    $out = ($sql | & $env:BEIROOT_SYNC_TEST_QUERY) -join "`n"
    foreach ($r in @($out | ConvertFrom-Json)) { if ($null -ne $r) { [void]$rows.Add($r) } }
    return ,$rows
  }
  $cmd = $script:conn.CreateCommand()
  $cmd.CommandText = $sql
  $rd = $cmd.ExecuteReader()
  try {
    while ($rd.Read()) {
      $h = [ordered]@{}
      for ($i = 0; $i -lt $rd.FieldCount; $i++) {
        $v = $rd.GetValue($i)
        if ($v -is [System.DBNull]) { $v = $null }
        $h[$rd.GetName($i)] = $v
      }
      [void]$rows.Add([pscustomobject]$h)
    }
  } finally { $rd.Close(); $cmd.Dispose() }
  return ,$rows
}

function Get-MaxZId {
  $r = Invoke-Query 'select coalesce(max(Id), 0) as m from ZReport'
  return [int64]$r[0].m
}

function Get-DocTypeId([string]$code) {
  $r = Invoke-Query ("select Id from DocumentType where Code = '" + [int]$code + "'")
  if ($r.Count -gt 0) { return [int64]$r[0].Id } else { return [int64]-1 }
}

function Build-Report($z) {
  $zid = [int64]$z.Id; $from = [int64]$z.FromDocumentId; $to = [int64]$z.ToDocumentId
  $sales = Get-DocTypeId '200'; $refund = Get-DocTypeId '220'

  $payments = New-Object System.Collections.ArrayList
  foreach ($p in (Invoke-Query ("select coalesce(pt.Name, 'Unknown') as name, cast(sum(p.Amount) as real) as amount, count(*) as cnt " +
      "from Payment p left join PaymentType pt on pt.Id = p.PaymentTypeId where p.ZReportId = $zid group by pt.Name"))) {
    [void]$payments.Add([ordered]@{ name = [string]$p.name; amount = [double]$p.amount; count = [int]$p.cnt })
  }

  $docs = Invoke-Query ("select count(*) as n, " +
    "coalesce(sum(case when DocumentTypeId = $sales then 1 else 0 end), 0) as salesCount, " +
    "cast(coalesce(sum(case when DocumentTypeId = $sales then Total else 0 end), 0) as real) as salesTotal, " +
    "coalesce(sum(case when DocumentTypeId = $refund then 1 else 0 end), 0) as refundCount, " +
    "cast(coalesce(sum(case when DocumentTypeId = $refund then abs(Total) else 0 end), 0) as real) as refundTotal " +
    "from Document where Id between $from and $to")
  $d = $docs[0]
  $expected = 0; if ($to -ge $from -and $from -gt 0) { $expected = $to - $from + 1 }
  $missing = [Math]::Max(0, $expected - [int64]$d.n)

  $items = New-Object System.Collections.ArrayList
  foreach ($it in (Invoke-Query ("select pr.Name as name, cast(sum(di.Quantity) as real) as qty, " +
      "cast(sum(di.TotalAfterDocumentDiscount) as real) as total from DocumentItem di " +
      "join Document d on d.Id = di.DocumentId join Product pr on pr.Id = di.ProductId " +
      "where d.Id between $from and $to and d.DocumentTypeId = $sales group by pr.Name order by pr.Name"))) {
    [void]$items.Add([ordered]@{ name = [string]$it.name; qty = [double]$it.qty; total = [double]$it.total })
  }

  return [ordered]@{
    zId = $zid; zNumber = [int64]$z.Number; closedAt = [string]$z.ClosedAt
    fromDoc = $from; toDoc = $to; docCount = [int64]$d.n; missingDocs = [int64]$missing
    salesCount = [int64]$d.salesCount; salesTotal = [double]$d.salesTotal
    refundCount = [int64]$d.refundCount; refundTotal = [double]$d.refundTotal
    payments = $payments.ToArray(); items = $items.ToArray()
  }
}

function Get-Products {
  $list = New-Object System.Collections.ArrayList
  foreach ($p in (Invoke-Query ("select p.Name as name, cast(p.Price as real) as price, g.Name as grp, p.IsEnabled as enabled " +
      "from Product p left join ProductGroup g on g.Id = p.ProductGroupId order by p.Name"))) {
    [void]$list.Add([ordered]@{ name = [string]$p.name; price = [double]$p.price; group = [string]$p.grp; enabled = ([int]$p.enabled -ne 0) })
  }
  return ,$list
}

# ---------- Sending ----------

function Send-Beiroot($cfg, [string]$kind, $payload) {
  $body = [ordered]@{ kind = $kind; agent = $Version }
  foreach ($k in $payload.Keys) { $body[$k] = $payload[$k] }
  $json = $body | ConvertTo-Json -Depth 8 -Compress
  $bytes = [System.Text.Encoding]::UTF8.GetBytes($json)
  $uri = $cfg.apiUrl.TrimEnd('/') + '/api/aronium'
  try {
    return Invoke-RestMethod -Uri $uri -Method Post -Body $bytes -ContentType 'application/json; charset=utf-8' `
      -Headers @{ Authorization = 'Bearer ' + $cfg.deviceKey } -TimeoutSec 30 -UseBasicParsing
  } catch {
    $code = $null; $detail = $_.Exception.Message
    try { $code = [int]$_.Exception.Response.StatusCode } catch { }
    try { if ($_.ErrorDetails -and $_.ErrorDetails.Message) { $detail = $_.ErrorDetails.Message } } catch { }
    throw ("Sending $kind failed" + $(if ($code) { " ($code)" } else { '' }) + ": $detail")
  }
}

# ---------- Main ----------

[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12

$mutex = New-Object System.Threading.Mutex($false, 'Local\BeirootSync')
if (-not $mutex.WaitOne(0)) { exit 0 }   # a previous run is still going
try {
  $cfg = Read-Json $ConfigPath
  if (-not $cfg) { Write-Log 'No config.json. Run the installer.'; exit 1 }
  $state = Read-Json $StatePath
  if (-not $state) { $state = [pscustomobject]@{ lastZId = $null; lastProductsAt = $null; lastError = $null } }
  foreach ($k in 'lastZId', 'lastProductsAt', 'lastError', 'lastSentAt') {
    if (-not ($state.PSObject.Properties.Name -contains $k)) { $state | Add-Member -NotePropertyName $k -NotePropertyValue $null }
  }

  $errorText = $null; $sent = 0; $pending = 0
  try {
    Open-Aronium $cfg
    if ($null -eq $state.lastZId) { $state.lastZId = Get-MaxZId; Save-State $state; Write-Log "Starting from Z report id $($state.lastZId)." }

    $zs = Invoke-Query ("select Id, Number, FromDocumentId, ToDocumentId, substr(DateCreated, 1, 19) as ClosedAt " +
      "from ZReport where Number > 0 and Id > " + [int64]$state.lastZId + " order by Id limit $MaxReportsPerRun")
    $pending = $zs.Count
    foreach ($z in $zs) {
      $report = Build-Report $z
      $r = Send-Beiroot $cfg 'zreport' @{ report = $report }
      $state.lastZId = [int64]$z.Id; $state.lastSentAt = (Get-Date -Format 's'); Save-State $state
      $sent++; $pending--
      $note = if ($r.duplicate) { ' (already had it)' } elseif ($r.conflict) { ' (DIFFERENT from before: owner alerted)' } else { '' }
      $sum = 0.0; foreach ($p in $report.payments) { $sum += [double]$p.amount }
      Write-Log ("Sent Z report no. $($z.Number) closed $($z.ClosedAt), payments " + ('{0:N0}' -f $sum) + $note)
    }

    $due = $true
    if ($state.lastProductsAt) { $due = ((Get-Date) - [datetime]$state.lastProductsAt).TotalHours -ge $ProductsEveryHours }
    if ($due -or $Check) {
      $products = Get-Products
      $r = Send-Beiroot $cfg 'products' @{ products = $products.ToArray() }
      $state.lastProductsAt = (Get-Date -Format 's'); Save-State $state
      Write-Log "Sent $($products.Count) Aronium item names."
    }
  } catch {
    $errorText = $_.Exception.Message
    Write-Log "ERROR: $errorText"
  } finally { Close-Aronium }

  if ($errorText -ne $state.lastError) { $state.lastError = $errorText; Save-State $state }
  try {
    $hb = Send-Beiroot $cfg 'heartbeat' @{ status = [ordered]@{
      version = $Version; computer = $env:COMPUTERNAME; lastZId = $state.lastZId; pending = $pending
      lastSentAt = $state.lastSentAt; error = $errorText; at = (Get-Date -Format 's') } }
    if ($Check) { Write-Log "Connected to Beiroot. Branch: $($hb.branch)." }
  } catch { Write-Log "ERROR: $($_.Exception.Message)"; if ($Check) { exit 2 } }
  if ($Check -and $errorText) { exit 3 }
} finally {
  $mutex.ReleaseMutex(); $mutex.Dispose()
}
