' Hidden launcher for the HeyARP worker watchdog.
' Task Scheduler starts this script with wscript.exe, which has no console window.
' This script then runs node.exe with window style 0, so the per-minute watchdog tick stays in the background.

Option Explicit

Dim shell, fso, scriptDir, watchdog, i, command, forwardedArgs

Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")

scriptDir = fso.GetParentFolderName(WScript.ScriptFullName)
watchdog = fso.BuildPath(scriptDir, "arp-worker-watchdog.js")
forwardedArgs = ""

' Forward every Task Scheduler argument to the Node watchdog.
For i = 0 To WScript.Arguments.Count - 1
    forwardedArgs = forwardedArgs & " " & Quote(WScript.Arguments(i))
Next

If Len(forwardedArgs) = 0 Then
    forwardedArgs = " --workspace " & Quote(shell.CurrentDirectory)
End If

' Use cmd.exe so Windows can resolve node.exe from PATH.
command = "cmd.exe /d /s /c ""node " & Quote(watchdog) & forwardedArgs & """"

' 0 = hidden window, True = wait for this watchdog tick to finish.
shell.Run command, 0, True

Function Quote(value)
    Quote = """" & Replace(value, """", "\""") & """"
End Function
