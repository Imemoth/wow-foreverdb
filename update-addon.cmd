@echo off
setlocal
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\update-addon.ps1" %*
exit /b %ERRORLEVEL%
