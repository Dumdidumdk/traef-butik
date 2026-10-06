@echo off
rem Kører alle tests for Træf-butik og skriver en kort oversigt.
rem Brug: test\koer-tests.cmd            (alle)
rem       test\koer-tests.cmd hurtig     (uden belastningstest)
setlocal
chcp 65001 >nul
cd /d "%~dp0.."

rem Find den bærbare Node: NODE-variablen, projektets runtime, hovedmappens runtime eller PATH.
set "NODEEXE=%NODE%"
if not defined NODEEXE if exist "runtime\node\node.exe" set "NODEEXE=%CD%\runtime\node\node.exe"
if not defined NODEEXE if exist "%~dp0..\..\traef-butik\runtime\node\node.exe" set "NODEEXE=%~dp0..\..\traef-butik\runtime\node\node.exe"
if not defined NODEEXE if exist "%USERPROFILE%\Documents\GitHub\traef-butik\runtime\node\node.exe" set "NODEEXE=%USERPROFILE%\Documents\GitHub\traef-butik\runtime\node\node.exe"
if not defined NODEEXE set "NODEEXE=node"
echo Node: %NODEEXE%
"%NODEEXE%" --version || (echo Node blev ikke fundet. Saet NODE=sti\til\node.exe & exit /b 1)

set "R_API=SPRUNGET OVER"
set "R_BEL=SPRUNGET OVER"
set "R_BRO=SPRUNGET OVER"
set FEJL=0

echo.
echo ===== API-tests (SPEC, tillæg 1, 2 og 3) og opdatering =====
"%NODEEXE%" --test --test-concurrency=1 --test-reporter=spec test\api.test.js test\katalog.test.js test\migration.test.js test\roller.test.js test\eksport.test.js test\opdatering.test.js
if errorlevel 1 (set "R_API=FEJL" & set FEJL=1) else set "R_API=OK"

if /i "%~1"=="hurtig" goto browser
echo.
echo ===== Belastningstest (250 kunder) =====
"%NODEEXE%" test\belastning.js
if errorlevel 1 (set "R_BEL=FEJL" & set FEJL=1) else set "R_BEL=OK"

:browser
echo.
echo ===== Browsertest =====
"%NODEEXE%" test\browser.js
if errorlevel 2 (set "R_BRO=SPRUNGET OVER (ingen Chrome)") else if errorlevel 1 (set "R_BRO=FEJL" & set FEJL=1) else set "R_BRO=OK"

echo.
echo ===== Oversigt =====
echo   API-tests:        %R_API%
echo   Belastningstest:  %R_BEL%
echo   Browsertest:      %R_BRO%
if "%FEJL%"=="1" (echo   Samlet: FEJL - se detaljerne ovenfor.) else (echo   Samlet: ALT OK)
endlocal & exit /b %FEJL%
