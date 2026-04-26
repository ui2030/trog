@echo off
REM TROG 게임 서버 부트스트랩 — trpg 콘다 환경 활성화 + main.py 실행
REM 더블클릭 한 번으로 서버 기동. base 아나콘다의 pydantic 충돌 회피.
REM 터널은 tunnel.bat 별도 창에서 따로 띄우면 된다.

cd /d "%~dp0"

REM 콘다 활성화 — Anaconda 의 conda.bat 직접 호출 (PATH 의존성 X)
call "%USERPROFILE%\anaconda3\Scripts\activate.bat" trpg
if %ERRORLEVEL% NEQ 0 (
    echo [!] trpg 환경 활성화 실패. 아나콘다 경로 또는 환경 이름 확인:
    echo     %USERPROFILE%\anaconda3\envs\trpg
    pause
    exit /b 1
)

echo [+] trpg 환경 활성화됨
echo [+] TROG 서버 기동: http://localhost:8080
echo.

python main.py

REM 서버가 Ctrl+C / 에러로 종료되면 창 유지 (로그 확인용)
echo.
echo [!] 서버가 종료됐습니다. 창을 닫으려면 아무 키나 누르세요.
pause
