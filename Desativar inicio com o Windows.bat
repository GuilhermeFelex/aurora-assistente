@echo off
powershell -NoProfile -ExecutionPolicy Bypass -Command "$f=Join-Path ([Environment]::GetFolderPath('Startup')) 'Aurora.lnk'; if (Test-Path $f) { Remove-Item $f; 'removido' } else { 'nao estava ativo' }"
echo   Inicio automatico desativado.
pause
