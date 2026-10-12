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

# 4. Start from the newest closed register, so old days are not sent again.
#    -SendLatest (or answering Y) also sends the most recent one now, to test.
if (-not $SendLatest -and -not $env:BEIROOT_SYNC_TEST_QUERY) {
  $a = Read-Host 'Send the most recent closed register now, as a test? (Y/N, branch laptops: N)'
  $SendLatest = ($a -match '^[Yy]')
}
try {
  if ($env:BEIROOT_SYNC_TEST_QUERY) {
    $max = [int64](('select coalesce(max(Id), 0) as m from ZReport' | & $env:BEIROOT_SYNC_TEST_QUERY | ConvertFrom-Json)[0].m)
  } else {
    Add-Type -Path $dll
    $c = New-Object System.Data.SQLite.SQLiteConnection("Data Source=$db;Version=3;Read Only=True;FailIfMissing=True;Pooling=False")
    $c.Open(); $cmd = $c.CreateCommand(); $cmd.CommandText = 'select coalesce(max(Id), 0) from ZReport'
    $max = [int64]$cmd.ExecuteScalar(); $c.Close()
  }
} catch { Stop-Install "Could not read Aronium's database: $($_.Exception.Message)" }
$start = $max; if ($SendLatest -and $max -gt 0) { $start = $max - 1 }
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
