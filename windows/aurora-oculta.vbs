' Inicia a Aurora sem nenhuma janela aberta.
' Usado pelo "Iniciar Aurora (sem janela).bat" e pelo inicio automatico com o Windows.
' Com o argumento "abrir", tambem abre o Chrome quando ela estiver pronta.
' Tudo o que ela imprimiria na tela vai para aurora\aurora.log.
Set fso = CreateObject("Scripting.FileSystemObject")
pasta = fso.GetParentFolderName(fso.GetParentFolderName(WScript.ScriptFullName))
Set sh = CreateObject("WScript.Shell")
sh.CurrentDirectory = pasta
comando = "start"
If WScript.Arguments.Count > 0 Then
  If LCase(WScript.Arguments(0)) = "abrir" Then comando = "run aurora"
End If
sh.Run "cmd /c npm.cmd " & comando & " > ""aurora\aurora.log"" 2>&1", 0, False
