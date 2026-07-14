@echo off
REM TROG public tunnel -- Cloudflare Quick Tunnel. ASCII only (see docs/BAT_ENCODING_FIX.md).
REM Finds cloudflared even when it is not on PATH (fresh install / PATH not refreshed).
setlocal

set "CF="
where cloudflared >nul 2>&1 && set "CF=cloudflared"
if not defined CF if exist "%ProgramFiles(x86)%\cloudflared\cloudflared.exe" set "CF=%ProgramFiles(x86)%\cloudflared\cloudflared.exe"
if not defined CF if exist "%ProgramFiles%\cloudflared\cloudflared.exe" set "CF=%ProgramFiles%\cloudflared\cloudflared.exe"
if not defined CF if exist "%LOCALAPPDATA%\Microsoft\WinGet\Links\cloudflared.exe" set "CF=%LOCALAPPDATA%\Microsoft\WinGet\Links\cloudflared.exe"

if not defined CF (
    echo [!] cloudflared not found. Install it with:
    echo     winget install --id Cloudflare.cloudflared
    pause
    exit /b 1
)

echo [+] TROG tunnel: http://localhost:8080 -^> Cloudflare
echo [+] Give the https://....trycloudflare.com URL below to your friends.
echo.
"%CF%" tunnel --url http://localhost:8080 --no-autoupdate
