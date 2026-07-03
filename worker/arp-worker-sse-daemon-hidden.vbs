' Hidden launcher for the HeyARP worker SSE daemon.
' Task Scheduler starts this script with wscript.exe, which has no console window.

Option Explicit

Dim shell, fso, scriptDir, daemon, i, command, forwardedArgs

Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")

scriptDir = fso.GetParentFolderName(WScript.ScriptFullName)
daemon = fso.BuildPath(scriptDir, "arp-worker-sse-daemon.js")
forwardedArgs = ""

For i = 0 To WScript.Arguments.Count - 1
    forwardedArgs = forwardedArgs & " " & Quote(WScript.Arguments(i))
Next

If Len(forwardedArgs) = 0 Then
    forwardedArgs = " --workspace " & Quote(shell.CurrentDirectory)
End If

command = "cmd.exe /d /s /c ""node " & Quote(daemon) & forwardedArgs & """"
shell.Run command, 0, True

Function Quote(value)
    Quote = """" & Replace(value, """", "\""") & """"
End Function
