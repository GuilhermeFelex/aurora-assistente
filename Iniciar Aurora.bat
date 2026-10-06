@echo off
title Aurora
cd /d "%~dp0"

echo.
echo   A.U.R.O.R.A. - iniciando...
echo   (deixe esta janela aberta enquanto usa a Aurora; feche-a para desligar)
echo.

where node >nul 2>nul
if errorlevel 1 (
  echo   Node.js nao encontrado. Instale em https://nodejs.org e tente de novo.
  pause
  exit /b 1
)

rem As dependencias sao instaladas/atualizadas automaticamente pelo scripts\start.mjs.
call npm.cmd run aurora
pause
