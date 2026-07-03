' Hidden launcher for the HeyARP one-second watchdog loop.
' Task Scheduler starts this script with wscript.exe, which has no console window.

Option Explicit

Dim shell, fso, scriptDir, loopScript, i, command, forwardedArgs

Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")

scriptDir = fso.GetParentFolderName(WScript.ScriptFullName)
loopScript = fso.BuildPath(scriptDir, "arp-worker-watchdog-loop.js")
forwardedArgs = ""

For i = 0 To WScript.Arguments.Count - 1
    forwardedArgs = forwardedArgs & " " & Quote(WScript.Arguments(i))
Next

If Len(forwardedArgs) = 0 Then
    forwardedArgs = " --workspace " & Quote(shell.CurrentDirectory)
End If

command = "cmd.exe /d /s /c ""node " & Quote(loopScript) & forwardedArgs & """"
shell.Run command, 0, True

Function Quote(value)
    Quote = """" & Replace(value, """", "\""") & """"
End Function
