@echo off
chcp 65001 >nul
rem Dusk Cellar 설치 (윈도우). 이 파일을 리스 폴더에 넣고 더블클릭하세요.
cd /d "%~dp0"
where git >nul 2>nul || (echo [실패] git이 없어요. https://git-scm.com 에서 설치한 뒤 다시 실행해 주세요. & pause & exit /b 1)
where node >nul 2>nul || (echo [실패] Node.js가 없어요. 22 이상을 https://nodejs.org 에서 설치해 주세요. & pause & exit /b 1)
for /f %%v in ('node -p "process.versions.node.split('.')[0]"') do set NODEMAJOR=%%v
if %NODEMAJOR% LSS 22 (echo [실패] Node.js가 낮아요. 22 이상이 필요해요. & pause & exit /b 1)
if not defined DUSK_CELLAR_REPO set DUSK_CELLAR_REPO=https://github.com/Pyser08/Dusk-Cellar
if exist Dusk-Cellar\.git (
  echo 이미 설치돼 있어서 최신으로 받아요
  git -C Dusk-Cellar pull --ff-only || (echo [실패] 업데이트에 실패했어요. & pause & exit /b 1)
) else (
  if exist Dusk-Cellar (echo [실패] Dusk-Cellar 폴더가 이미 있는데 git 저장소가 아니에요. 옮기거나 지우고 다시 실행해 주세요. & pause & exit /b 1)
  git clone %DUSK_CELLAR_REPO% Dusk-Cellar || (echo [실패] 내려받기에 실패했어요. & pause & exit /b 1)
)
cd Dusk-Cellar
node setup.cjs %*
echo.
echo 끝났어요.
pause
