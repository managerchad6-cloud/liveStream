# Cursor Tasks

## Task: Diagnose FFmpeg spawn EPERM on Windows

Run these in the same PowerShell session you use to start `npm run animation`. Paste outputs/errors.

1) Verify the exe runs directly:
```powershell
& $env:FFMPEG_PATH -version
```

2) Check if Windows blocked the file (Mark-of-the-Web):
```powershell
Get-Item $env:FFMPEG_PATH | Format-List *
```

3) Force unblocking:
```powershell
Unblock-File -Path $env:FFMPEG_PATH
```

4) Minimal Node spawn test (bypasses our code):
```powershell
node -e "const {spawn}=require('child_process'); const p=spawn(process.env.FFMPEG_PATH,['-version']); p.on('error',e=>console.error('spawn error',e)); p.stdout.on('data',d=>console.log(d.toString()));"
```

If any command errors with EPERM, note which one.

---

## Results (run 2026-02-03)

1. **`& $env:FFMPEG_PATH -version`** — **OK.** FFmpeg runs when invoked directly from PowerShell (version 7.1.1-full_build).

2. **`Get-Item $env:FFMPEG_PATH | Format-List *`** — **OK.** File exists; `Mode: -a----`, `Attributes: Archive`. No Zone.Identifier / Mark-of-the-Web shown in this output.

3. **`Unblock-File -Path $env:FFMPEG_PATH`** — **OK.** Completed without error.

4. **Minimal Node spawn test** — **EPERM when run inside Cursor sandbox.** Same one-liner **succeeds** when run with full permissions (outside sandbox). So:
   - **Conclusion:** EPERM is from the **sandbox blocking Node from spawning that executable**, not from Mark-of-the-Web or the file itself.
   - **Workaround:** Run `npm run animation` in a normal PowerShell/terminal (e.g. outside Cursor), with `$env:FFMPEG_PATH` set. There, Node spawn of FFmpeg should work.
