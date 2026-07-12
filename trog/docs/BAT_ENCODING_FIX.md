# start.bat / tunnel.bat 인코딩 수정 (2026-05-10)

## 증상

`start.bat` 실행 시 다음과 같이 명령어 자체가 깨진 채 cmd 가 해석:

```
'?Anaconda'은(는) 내부 또는 외부 명령... 아닙니다.
'cho'은(는) 내부 또는 외부 명령... 아닙니다.
'EM'은(는) 내부 또는 외부 명령... 아닙니다.
```

## 원인

두 `.bat` 파일이 **BOM 없는 UTF-8** + **LF(Unix) 줄바꿈** 으로 저장되어 있었음.

- 한국어 Windows 의 cmd.exe 는 시스템 코드페이지(cp949)로 배치 파일을 읽음
- BOM 이 없으면 UTF-8 인지 모르고 cp949 로 해석 → 한국어 주석이 mojibake
- LF only 줄바꿈도 라인 파싱 신뢰성을 떨어뜨림

## 1차 시도 (실패) — UTF-8 BOM + CRLF

근거: "Win10/11 cmd.exe 는 UTF-8 BOM 을 인식해서 UTF-8 모드로 전환한다" 는 통설.

결과: cmd 가 BOM 을 인식하지 못하고 첫 줄을 `癤?echo off` 로 출력 (BOM 바이트 `EF BB BF` 가 cp949 로 `癤?` 표시됨). 통설이 틀렸거나, 최소한 한국어 Windows 11 환경에서는 적용 안 됨.

## 2차 수정 (성공) — cp949 (시스템 ANSI) + CRLF

cmd 가 별도 설정 없이 그대로 읽는 코드페이지(=cp949)로 직접 저장.

```powershell
$cp949 = [System.Text.Encoding]::GetEncoding(949)
foreach ($f in @('start.bat','tunnel.bat')) {
  $path = "c:\Users\ui2030\Documents\trpg\trog\$f"
  $content = Get-Content -Raw -Encoding UTF8 $path
  if ($content[0] -eq [char]0xFEFF) { $content = $content.Substring(1) }
  $content = $content -replace "`r?`n", "`r`n"
  [System.IO.File]::WriteAllText($path, $content, $cp949)
}
```

검증:

```
start.bat  -> BOM:False first8:40 65 63 68 6F 20 6F 66 (=@echo of)
tunnel.bat -> BOM:False first8:40 65 63 68 6F 20 6F 66 (=@echo of)
```

한국어 주석 보존 확인 (cp949 로 읽었을 때):
```
@echo off
REM TROG 게임 서버 부트스트랩 ? trpg 콘다 환경 활성화 + main.py 실행
```

⚠ em-dash(`—`)는 cp949 에 없어서 `?` 로 치환됨. 주석 안이라 실행에는 영향 없음. 신경 쓰이면 ASCII `-` 또는 `--` 로 교체 권장.

## 셀프 리뷰

- ✅ cp949 는 cmd.exe 가 한국어 Windows 에서 default 로 읽는 코드페이지 → 추가 설정 없이 정상 인식
- ✅ CRLF 로 통일 → 라인 파싱 손실 없음
- ✅ 기존 `chcp 65001 > nul` + `set PYTHONIOENCODING=utf-8` 조합은 유지 (Python stdout 한국어 출력용)
- ⚠ **편집기 주의** — VSCode 가 기본 UTF-8 로 저장하면 mojibake 재발. `.bat` 편집 시 우하단에서 `Korean (Windows 949)` 또는 `EUC-KR` 로 명시적으로 저장. 또는 편집 후 위 PowerShell 스니펫 재실행
- ⚠ em-dash(`—`) 등 cp949 에 없는 유니코드 문자 사용 금지. 코드 안에서는 ASCII `-` / `--` 만
- ⚠ **git 도입 시** — `.gitattributes` 에 `*.bat text eol=crlf working-tree-encoding=cp949` 권장
- ⚠ Python 3 자체로 `.bat` 을 실행하면 안 됨 (이전 세션의 `python tunnel.bat` 에러)

## 정상 실행 절차 재확인

1. **터미널 1**: `start.bat` → http://localhost:8080 서버 기동
2. **터미널 2**: `tunnel.bat` → trycloudflare.com 공개 URL (Cloudflare 측 503 시 잠시 후 재시도)
