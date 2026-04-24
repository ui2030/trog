@echo off
REM TROG 공개 터널 — Cloudflare Quick Tunnel
REM 더블클릭으로 실행. 콘솔에 https://*.trycloudflare.com 주소가 뜨면 친구에게 공유.
REM 창 닫으면 터널 종료. 서버(main.py)는 별도 터미널에서 실행할 것.

where cloudflared >nul 2>&1
if %ERRORLEVEL% NEQ 0 (
    echo [!] cloudflared가 PATH에 없습니다. 새 터미널을 열거나 아래 경로로 직접 실행하세요:
    echo     %LOCALAPPDATA%\Microsoft\WinGet\Packages\Cloudflare.cloudflared_Microsoft.Winget.Source_8wekyb3d8bbwe\cloudflared.exe
    pause
    exit /b 1
)

echo [+] TROG 터널 기동: http://localhost:8080 -^> Cloudflare
echo [+] 아래 trycloudflare.com URL이 친구에게 줄 주소입니다.
echo.
cloudflared tunnel --url http://localhost:8080 --no-autoupdate
