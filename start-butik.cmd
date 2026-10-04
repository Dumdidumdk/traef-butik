@echo off
rem Starter Traef-butikken. Dobbeltklik for at starte.
chcp 65001 >nul
cd /d "%~dp0"
title Traef-butik
if not exist "runtime\node\node.exe" (
  echo.
  echo   Kan ikke finde runtime\node\node.exe
  echo   Laeg den baerbare Node.js 24 i mappen runtime\node\
  echo.
  pause
  exit /b 1
)
"runtime\node\node.exe" --disable-warning=ExperimentalWarning server\server.js
echo.
echo   Serveren er stoppet.
pause
