@echo off
echo Starting LiveStream Animation System...
echo.

:: Start API server in background
start "API Server" cmd /c "node server.js"

:: Wait a moment
timeout /t 2 /nobreak > nul

:: Start animation server
start "Animation Server" cmd /c "cd animation-server && node server.js"

echo.
echo Servers starting...
echo   API Server: http://localhost:3002
echo   Animation Server: http://localhost:3003
echo.
echo Open http://localhost:3002 in your browser
echo.
pause
