@echo off
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js nao foi encontrado. Instale o Node.js 22 ou superior e tente novamente.
  pause
  exit /b 1
)
start "" http://localhost:3210
node server.js
