@echo off
chcp 65001 >nul
echo === 鯖工房 レジストリ修復 ===
node "%~dp0scripts\fix-registry.js"
if errorlevel 1 (
  pause
  exit /b 1
)
echo.
echo 鯖工房を起動します...
start "" "%LOCALAPPDATA%\Programs\SabaKobo\SabaKobo.exe"
pause
