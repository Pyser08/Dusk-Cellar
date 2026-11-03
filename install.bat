@echo off
chcp 65001 >nul
rem Dusk Cellar 설치 (윈도우). 이 파일을 리스 폴더에 넣고 더블클릭하세요. git·Node가 없어도 돼요(리스 폴더의 bin\node.exe를 써요).
cd /d "%~dp0"
if not defined DUSK_CELLAR_REPO set DUSK_CELLAR_REPO=https://github.com/Pyser08/Dusk-Cellar
if not defined DUSK_CELLAR_REF set DUSK_CELLAR_REF=main
if not defined DUSK_CELLAR_ARCHIVE set DUSK_CELLAR_ARCHIVE=%DUSK_CELLAR_REPO%/archive/refs/heads/%DUSK_CELLAR_REF%.tar.gz

set "NODE="
if exist "%~dp0bin\node.exe" set "NODE=%~dp0bin\node.exe"
if not defined NODE (
  where node >nul 2>nul && set "NODE=node"
)
if not defined NODE (echo [실패] Node.js를 못 찾았어요. 리스 폴더^(bin\node.exe가 있는 곳^)에 이 파일을 넣거나 Node.js 22 이상을 설치해 주세요. & pause & exit /b 1)

if exist Dusk-Cellar\.git (
  echo 이미 설치돼 있어서 최신으로 받아요
  git -C Dusk-Cellar pull --ff-only || (echo [실패] 업데이트에 실패했어요. & pause & exit /b 1)
  goto run
)
where git >nul 2>nul
if not errorlevel 1 if not exist Dusk-Cellar (
  git clone %DUSK_CELLAR_REPO% Dusk-Cellar || (echo [실패] 내려받기에 실패했어요. & pause & exit /b 1)
  goto run
)
rem git이 없거나 git 없이 설치했던 폴더: 압축 파일을 받아 풀어요(dusk-data는 그대로 둬요)
set "TMPD=%TEMP%\dusk-cellar-%RANDOM%"
mkdir "%TMPD%\x" || (echo [실패] 임시 폴더를 만들지 못했어요. & pause & exit /b 1)
echo 내려받는 중… %DUSK_CELLAR_ARCHIVE%
curl.exe -fsSL "%DUSK_CELLAR_ARCHIVE%" -o "%TMPD%\c.tgz" || (echo [실패] 내려받기에 실패했어요. ^(윈도우 10 이상 필요^) & pause & exit /b 1)
tar.exe -xzf "%TMPD%\c.tgz" -C "%TMPD%\x" || (echo [실패] 압축을 풀지 못했어요. & pause & exit /b 1)
for /d %%d in ("%TMPD%\x\*") do set "SRC=%%d"
if not exist "%SRC%\setup.cjs" (echo [실패] 받은 파일이 올바르지 않아요. & pause & exit /b 1)
if not exist Dusk-Cellar mkdir Dusk-Cellar
xcopy /E /I /Y /Q "%SRC%\*" Dusk-Cellar\ >nul || (echo [실패] 파일을 복사하지 못했어요. & pause & exit /b 1)
rmdir /s /q "%TMPD%" 2>nul

:run
cd Dusk-Cellar
"%NODE%" setup.cjs %*
echo.
echo 끝났어요.
pause
