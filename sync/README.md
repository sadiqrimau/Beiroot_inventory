# Beiroot Sync (branch laptops)

Sends Aronium's end-of-day (Z) report to the Beiroot system as soon as the cashier closes the register. Nothing is printed, and the cashier never types in Aronium's figures.

- It only **reads** Aronium's database (`pos.db`), using the SQLite reader that comes with Aronium (`C:\Program Files\Aronium\System.Data.SQLite.dll`). Nothing to download, and Aronium is never changed.
- Runs every 5 minutes, hidden, while the Windows user is signed in (Windows scheduled task "Beiroot Sync").
- Sends: each closed register (payments by type, sales and refunds, items sold, and how many receipt numbers are missing), the list of Aronium item names (every 6 hours), and a "still here" signal.
- If the internet is down it simply tries again; nothing is lost. A register close is sent once; if it ever arrives again with different figures the owner is alerted.
- Needs Windows 10 or 11 (Windows PowerShell 5.1 is built in). No administrator rights.

## Install on a laptop

1. On the website: **Settings → Aronium sync → Add a branch laptop**. Pick the branch, name the laptop, **Create key**, copy the key.
2. Copy this `sync` folder to the laptop (USB or download).
3. Sign in to Windows as the user who runs Aronium. Double-click **Install Beiroot Sync.cmd**.
4. Press Enter for the website address, paste the key, answer **N** to "send the most recent closed register now" (answer **Y** only on a test laptop).
5. It shows "Connected to Beiroot. Branch: …". Done.

To check it later: **Check Beiroot Sync.cmd**. Log: `%LOCALAPPDATA%\BeirootSync\sync.log`. To remove: **Uninstall Beiroot Sync.cmd**. If a laptop is lost, revoke its key in Settings → Aronium sync.

## Files

| File | What it is |
| --- | --- |
| `beiroot-sync.ps1` | The program. Reads Aronium, sends to `/api/aronium`. |
| `install.ps1` | Installer (called by `Install Beiroot Sync.cmd`). Finds Aronium, saves the key, starts after the newest closed register, registers the task. |
| `run-hidden.vbs` | Starts the program without a window flashing. |
| `*.cmd` | Double-click helpers: install, check, uninstall. |

Installed to `%LOCALAPPDATA%\BeirootSync` (`config.json` holds the key; `state.json` the last register sent).
