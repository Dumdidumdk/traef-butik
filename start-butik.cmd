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
rem Resten staar i een blok, saa cmd har laest den hele, foer en opdatering udskifter denne fil.
rem scripts\opdater.js giver kode 10, naar en ny version er lagt paa plads; saa startes den nye start-butik.cmd.
(
  if /i not "%~1"=="efter-opdatering" if exist "scripts\opdater.js" (
    "runtime\node\node.exe" scripts\opdater.js
    if errorlevel 10 if not errorlevel 11 (
      call "%~f0" efter-opdatering
      exit /b
    )
  )
  "runtime\node\node.exe" --disable-warning=ExperimentalWarning server\server.js
  echo.
  echo   Serveren er stoppet.
  pause
  exit /b
)
