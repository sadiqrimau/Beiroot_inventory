@echo off
rem Removes Beiroot Sync from this laptop. Aronium is not touched.
powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "Unregister-ScheduledTask -TaskName 'Beiroot Sync' -Confirm:$false -ErrorAction SilentlyContinue; Remove-Item -Recurse -Force (Join-Path $env:LOCALAPPDATA 'BeirootSync') -ErrorAction SilentlyContinue; Write-Host 'Beiroot Sync removed.'"
pause
