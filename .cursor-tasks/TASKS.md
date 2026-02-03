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
