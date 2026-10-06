@echo off
cd /d "%~dp0"
call "%~dp0Parar Aurora.bat" silencioso
wscript.exe "%~dp0windows\aurora-oculta.vbs" abrir
echo.
echo   Aurora iniciando em segundo plano. O Chrome abre sozinho quando ela estiver pronta.
echo   Para desligar, use "Parar Aurora.bat". Registro em aurora\aurora.log.
timeout /t 6 >nul
