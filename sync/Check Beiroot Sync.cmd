@echo off
rem Runs Beiroot Sync once now and shows the result.
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%LOCALAPPDATA%\BeirootSync\beiroot-sync.ps1" -Check
pause
