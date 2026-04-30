@echo off
chcp 65001 > nul

if "%~1"=="" goto :no_args

cd /d "%~dp0"
node index.js %*
if errorlevel 1 goto :error

echo.
pause
exit /b 0

:no_args
echo.
echo Drag an audio file onto this .bat to process it.
echo Supported formats: .wav .mp3 .m4a .flac
echo.
pause
exit /b 1

:error
echo.
echo === ERROR ===
pause
exit /b 1
