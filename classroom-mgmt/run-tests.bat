@echo off
rem ===========================================================================
rem  Classroom Management - One-click Test Runner (Quick Mode, Windows double-click)
rem
rem  Case list mirrors the quick mode of run-tests.sh - keep both sides in sync.
rem  Full mode (real SIoT broker smoke + student real-machine test) needs Git Bash:
rem      ./run-tests.sh --full
rem  This script does NOT cover the two quality gates (line-count <= 300 / P0 emoji scan).
rem  Run run-tests.sh (Git Bash) for those.
rem
rem  WARNING - this file must stay PURE ASCII (no CJK, no BOM).
rem  Windows cmd.exe mis-parses UTF-8 CJK inside .bat/.cmd: a multi-byte pair decoded
rem  as GBK can yield a fake ')' or '"', which breaks block/quote pairing and makes the
rem  whole script fail with "'xxx' is not recognized as an internal or external command".
rem  LF line endings are fine for pure-ASCII batch; if you need CJK messages, use a
rem  .cmd file with CRLF + chcp 65001 instead (see the scripts inside the delivery package).
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

rem --- teacher ---
call :run_case "teacher selfcheck"        "%ROOT%teacher" "%NODE%" test\selfcheck.js "%TMPDB%"
call :run_case "teacher routes"           "%ROOT%teacher" "%NODE%" test\routes.js
call :run_case "teacher preset-pkg"       "%ROOT%teacher" "%NODE%" test\preset-pkg.test.js
call :run_case "teacher dashboard.dom"    "%ROOT%teacher" "%NODE%" test\dashboard.dom.test.js
call :run_case "teacher export-sanitize"  "%ROOT%teacher" "%NODE%" test\export-sanitize.test.js
call :run_case "teacher timer-restore"    "%ROOT%teacher" "%NODE%" test\timer-restore.test.js
call :run_case "teacher auth-cors"        "%ROOT%teacher" "%NODE%" test\auth-cors.test.js
call :run_case "teacher credential-gate"  "%ROOT%teacher" "%NODE%" test\credential-gate.test.js
call :run_case "teacher error-format"     "%ROOT%teacher" "%NODE%" test\error-format.test.js
call :run_case "teacher html-dedup"       "%ROOT%teacher" "%NODE%" test\html-dedup.test.js
call :run_case "teacher terminology"      "%ROOT%teacher" "%NODE%" test\terminology.test.js
call :run_case "teacher borrow-create"    "%ROOT%teacher" "%NODE%" test\borrow-create.test.js

rem --- preset studio ---
call :run_case "studio store"             "%ROOT%preset-studio" "%NODE%" test\store.test.js
call :run_case "studio renderer.dom"      "%ROOT%preset-studio" "%NODE%" test\renderer.dom.test.js

rem --- student ---
call :run_case "student protocol"         "%ROOT%student" "%NODE%" test\protocol.test.js
call :run_case "student renderer.dom"     "%ROOT%student" "%NODE%" test\renderer.dom.test.js
call :run_case "student shutdown-atomic"  "%ROOT%student" "%NODE%" test\shutdown-atomic.test.js

del /q "%TMPDB%"* 2>nul

echo.
echo ================================================================
if "%FAILED%"=="0" (
  echo   [PASS] All %PASS% checks passed
) else (
  echo   [FAIL] passed=%PASS% failed=%FAILED%
)
echo   NOTE: line-count / emoji quality gates are not run here.
echo         Use run-tests.sh (Git Bash) for those.
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
