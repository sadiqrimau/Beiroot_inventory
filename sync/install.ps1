# Beiroot Sync installer. Run it by double-clicking "Install Beiroot Sync.cmd".
# No administrator rights needed. Installs for the Windows user who runs Aronium.
param([string]$Key, [string]$ApiUrl, [switch]$SendLatest, [switch]$NoTask)

$ErrorActionPreference = 'Stop'
$Src = Split-Path -Parent $MyInvocation.MyCommand.Path
$Dest = Join-Path $env:LOCALAPPDATA 'BeirootSync'
$TaskName = 'Beiroot Sync'

function Say([string]$m, [string]$c = 'Gray') { Write-Host $m -ForegroundColor $c }
function Stop-Install([string]$m) { Say ''; Say "Not installed: $m" 'Red'; Say ''; exit 1 }

Say ''
Say 'Beiroot Sync: sends Aronium''s end-of-day report to the Beiroot system automatically.' 'Cyan'
Say 'It only reads Aronium. It never changes anything in Aronium.'
Say ''

# 1. Find Aronium's database and its SQLite reader (comes with Aronium; nothing to download).
$db = Join-Path $env:LOCALAPPDATA 'Aronium\Data\pos.db'
if (-not (Test-Path $db)) {
  Say "Aronium's database was not found at $db" 'Yellow'
  $db = Read-Host 'Paste the full path to pos.db (or press Enter to stop)'
  if (-not $db -or -not (Test-Path $db)) { Stop-Install 'Aronium database (pos.db) not found.' }
}
$dll = $null
foreach ($base in @($env:ProgramFiles, ${env:ProgramFiles(x86)}, $env:LOCALAPPDATA)) {
  if (-not $base) { continue }
  $p = Join-Path $base 'Aronium\System.Data.SQLite.dll'
  if (Test-Path $p) { $dll = $p; break }
}
if ($env:BEIROOT_SYNC_TEST_QUERY) { $dll = 'test' }
if (-not $dll) { Stop-Install 'Aronium''s System.Data.SQLite.dll was not found under Program Files\Aronium. Is Aronium installed on this laptop?' }
Say "Aronium database: $db"
Say "SQLite reader:    $dll"

# 2. Device key from Settings -> Aronium sync on the owner's screen.
if (-not $ApiUrl) {
  $ApiUrl = Read-Host 'Website address (press Enter for https://beiroot-inventory.vercel.app)'
  if (-not $ApiUrl) { $ApiUrl = 'https://beiroot-inventory.vercel.app' }
}
# Re-installing on the same laptop: the key already saved can be kept.
$oldKey = $null
try { $oldKey = (Get-Content -Raw (Join-Path $Dest 'config.json') | ConvertFrom-Json).deviceKey } catch { }
if (-not $Key -and $oldKey) {
  $k = (Read-Host 'This laptop already has a key. Press Enter to keep it, or paste a new one').Trim()
  $Key = if ($k) { $k } else { $oldKey }
}
if (-not $Key) { $Key = (Read-Host 'Paste the laptop key from Settings -> Aronium sync').Trim() }
if ($Key -notmatch '^[A-Za-z0-9_-]{20,100}$') { Stop-Install 'That does not look like a laptop key. Copy it again from Settings -> Aronium sync.' }

# 3. Copy the program.
New-Item -ItemType Directory -Force -Path $Dest | Out-Null
foreach ($f in 'beiroot-sync.ps1', 'run-hidden.vbs') {
  Copy-Item -Force (Join-Path $Src $f) (Join-Path $Dest $f)
  try { Unblock-File (Join-Path $Dest $f) } catch { }
}
$cfg = [ordered]@{ apiUrl = $ApiUrl.TrimEnd('/'); deviceKey = $Key; dbPath = $db; sqliteDll = $dll }
($cfg | ConvertTo-Json) | Set-Content -Path (Join-Path $Dest 'config.json') -Encoding UTF8

# 4. Where to start: registers closed in the last 24 hours are sent now (so last night's close
#    is not missed when installing the morning after); older ones are not sent.
#    -SendLatest (testing only) sends the most recent close whatever its age.
$sqlRecent = "select coalesce(max(Id), 0) as m from ZReport where substr(DateCreated, 1, 19) < datetime('now', 'localtime', '-1 day')"
$sqlMax = 'select coalesce(max(Id), 0) as m from ZReport'
function Get-One([string]$sql) {
  if ($env:BEIROOT_SYNC_TEST_QUERY) { return [int64](($sql | & $env:BEIROOT_SYNC_TEST_QUERY | ConvertFrom-Json)[0].m) }
  $cmd = $script:c.CreateCommand(); $cmd.CommandText = $sql; return [int64]$cmd.ExecuteScalar()
}
try {
  if (-not $env:BEIROOT_SYNC_TEST_QUERY) {
    Add-Type -Path $dll
    $script:c = New-Object System.Data.SQLite.SQLiteConnection("Data Source=$db;Version=3;Read Only=True;FailIfMissing=True;Pooling=False")
    $script:c.Open()
  }
  $max = Get-One $sqlMax
  $start = if ($SendLatest -and $max -gt 0) { $max - 1 } else { Get-One $sqlRecent }
  if (-not $env:BEIROOT_SYNC_TEST_QUERY) { $script:c.Close() }
} catch { Stop-Install "Could not read Aronium's database: $($_.Exception.Message)" }
if ($start -lt $max) { Say "Registers closed in the last 24 hours will be sent now." } else { Say "No register closed in the last 24 hours. The next close will be sent." }
$state = [ordered]@{ lastZId = $start; lastProductsAt = $null; lastError = $null; lastSentAt = $null }
($state | ConvertTo-Json) | Set-Content -Path (Join-Path $Dest 'state.json') -Encoding UTF8

# 5. First run now, showing the result.
Say ''; Say 'Checking the connection...'
& (Get-Process -Id $PID).Path -NoProfile -ExecutionPolicy Bypass -File (Join-Path $Dest 'beiroot-sync.ps1') -Check
$rc = $LASTEXITCODE
if ($rc -eq 2) { Stop-Install 'Could not reach the Beiroot website or the key was refused. Check the internet and the key, then run the installer again.' }
if ($rc -eq 3) { Say 'Connected, but reading Aronium gave an error (see above). It will keep trying every 5 minutes.' 'Yellow' }

# 6. Run every 5 minutes while this user is signed in, hidden.
if (-not $NoTask) {
  $action = New-ScheduledTaskAction -Execute 'wscript.exe' -Argument ('"' + (Join-Path $Dest 'run-hidden.vbs') + '"')
  $every = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Minutes 5) -RepetitionDuration (New-TimeSpan -Days 3650)
  $logon = New-ScheduledTaskTrigger -AtLogOn -User "$env:USERDOMAIN\$env:USERNAME"
  $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable `
    -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Minutes 4)
  $principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive -RunLevel Limited
  Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger @($every, $logon) -Settings $settings -Principal $principal -Force | Out-Null
  Say "Scheduled task '$TaskName' runs every 5 minutes."
}

Say ''
Say 'Installed. The cashier only needs to close the register in Aronium; no printing.' 'Green'
Say "Log file: $(Join-Path $Dest 'sync.log')"
Say ''
