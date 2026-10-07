@echo off
rem ==========================================================
rem  Dev-tree launcher: SIoT broker (1883) + teacher service
rem  (3000). Teacher runs the self-contained exe - NOT the
rem  WorkBuddy node.exe, which self-exits outside WorkBuddy.
rem  Double-click to run. Close the two minimized windows
rem  to stop the services.
rem ==========================================================
setlocal
cd /d "%~dp0"

set "TEACHER_DIR=%~dp0classroom-mgmt\teacher"
set "TEACHER_EXE=%TEACHER_DIR%\teacher-server.exe"
set "DIST_EXE=%TEACHER_DIR%\dist\classroom-mgmt-teacher.exe"

if not exist "%TEACHER_EXE%" (
  if exist "%DIST_EXE%" (
    echo Copying self-contained exe to teacher\ ...
    copy /y "%DIST_EXE%" "%TEACHER_EXE%" >nul
  )
)

if not exist "%TEACHER_EXE%" (
  echo [ERROR] teacher-server.exe not found. Build it first:
  echo   pkg classroom-mgmt\teacher server.js --config package.json
  pause
  exit /b 1
)

echo Starting SIoT broker (1883)...
start "SIoT-Broker" /min cmd /c "cd /d %~dp0SIoT_V2_Win_2618\SIoT_V2_Win_2618 && main.exe -c conf/config.json"

ping -n 5 127.0.0.1 >nul

echo Starting teacher service (3000)...
start "ClassroomTeacher-Service" /min cmd /c "cd /d "%TEACHER_DIR%" && "%TEACHER_EXE%""

ping -n 8 127.0.0.1 >nul

echo Checking service status...
netstat -ano | findstr ":3000" | findstr "LISTENING" >nul
if errorlevel 1 (
  echo [FAIL] Teacher service NOT listening on 3000
) else (
  echo [ OK ] Teacher service listening on 3000
)
netstat -ano | findstr ":1883" | findstr "LISTENING" >nul
if errorlevel 1 (
  echo [FAIL] SIoT broker NOT listening on 1883
) else (
  echo [ OK ] SIoT broker listening on 1883
)

start "" "http://127.0.0.1:3000"
echo.
echo Browser should show the big screen.
pause
