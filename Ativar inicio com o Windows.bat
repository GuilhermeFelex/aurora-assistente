@echo off
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -Command "$s=(New-Object -ComObject WScript.Shell).CreateShortcut((Join-Path ([Environment]::GetFolderPath('Startup')) 'Aurora.lnk')); $s.TargetPath='wscript.exe'; $s.Arguments='\"' + (Join-Path '%~dp0' 'windows\aurora-oculta.vbs') + '\"'; $s.WorkingDirectory='%~dp0'; $s.Description='Aurora em segundo plano'; $s.Save()"
if errorlevel 1 (
  echo   Nao consegui ativar o inicio automatico.
) else (
  echo   Pronto: a Aurora vai ligar sozinha, sem janela, quando voce entrar no Windows.
  echo   Para usar, e so abrir http://localhost:5173 no Chrome.
  echo   Para desfazer, rode "Desativar inicio com o Windows.bat".
)
pause
