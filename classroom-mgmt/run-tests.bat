@echo off
rem ===========================================================================
rem  Classroom Management - One-click Test Runner (Quick Mode, Windows double-click)
rem  Covers: teacher selfcheck/routes/dashboard.dom/editor.dom
rem           student protocol/renderer.dom
rem  Full mode (real broker) needs Git Bash:   ./run-tests.sh --full
rem ===========================================================================
setlocal enabledelayedexpansion

set "NODE=C:\Users\cqcz\.workbuddy\binaries\node\versions\22.22.2\node.exe"
if not exist "%NODE%" set "NODE=node"

set "ROOT=%~dp0"
set "PASS=0"
set "FAILED=0"

echo ================================================================
echo   Classroom Mgmt Test Runner (Quick Mode)
echo   Node: 
call "%NODE%" -v
echo ================================================================

set "TMPDB=%TEMP%\rt-selfcheck-%RANDOM%.db"
call :run_case "teacher selfcheck"        "%ROOT%teacher" "%NODE%" test\selfcheck.js "%TMPDB%"
call :run_case "teacher routes"           "%ROOT%teacher" "%NODE%" test\routes.js
call :run_case "teacher dashboard.dom"    "%ROOT%teacher" "%NODE%" test\dashboard.dom.test.js
call :run_case "teacher editor.dom"       "%ROOT%teacher" "%NODE%" test\editor.dom.test.js
call :run_case "student protocol"         "%ROOT%student" "%NODE%" test\protocol.test.js
call :run_case "student renderer.dom"     "%ROOT%student" "%NODE%" test\renderer.dom.test.js
del /q "%TMPDB%"* 2>nul

echo.
echo ================================================================
if "%FAILED%"=="0" (
  echo   [PASS] All %PASS% checks passed
) else (
  echo   [FAIL] passed=%PASS% failed=%FAILED%
)
echo ================================================================
echo.

if /i not "%~1"=="no-pause" pause
exit /b %FAILED%

rem ---------------------------------------------------------------------------
rem  run_case <name> <dir> <node> <script> [db_path]
rem ---------------------------------------------------------------------------
:run_case
set "NAME=%~1"
set "DIR=%~2"
set "NODE_BIN=%~3"
set "SCRIPT=%~4"
set "DB_ARG=%~5"
echo.
echo   -- %NAME%
pushd "%DIR%" 1>nul
if not "%DB_ARG%"=="" ( del /q "%DB_ARG%"* 2>nul & set "DB_PATH=%DB_ARG%" )
"%NODE_BIN%" %SCRIPT% >"%TEMP%\rt-last.log" 2>&1
set "RC=!errorlevel!"
if not "%DB_ARG%"=="" set "DB_PATH="
popd 1>nul
if "!RC!"=="0" (
  set /a PASS+=1
  echo   [PASS] %NAME%
) else (
  set /a FAILED+=1
  echo   [FAIL] %NAME%
  powershell -NoProfile -Command "Get-Content -Tail 12 '%TEMP%\rt-last.log'" 2>nul
)
exit /b 0