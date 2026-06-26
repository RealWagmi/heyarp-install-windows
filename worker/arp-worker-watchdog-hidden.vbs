' Hidden launcher for the HeyARP worker watchdog.
' Task Scheduler starts this script with wscript.exe, which has no console window.
' This script then runs node.exe with window style 0, so the per-minute watchdog tick stays in the background.

Option Explicit

Dim shell, fso, scriptDir, watchdog, workspace, i, command

Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")

scriptDir = fso.GetParentFolderName(WScript.ScriptFullName)
watchdog = fso.BuildPath(scriptDir, "arp-worker-watchdog.js")
workspace = ""

' Accept the same --workspace argument used by the Node watchdog.
For i = 0 To WScript.Arguments.Count - 1
    If WScript.Arguments(i) = "--workspace" And i + 1 < WScript.Arguments.Count Then
        workspace = WScript.Arguments(i + 1)
    End If
Next

If Len(workspace) = 0 Then
    workspace = shell.CurrentDirectory
End If

' Use cmd.exe so Windows can resolve node.exe from PATH.
command = "cmd.exe /d /s /c ""node " & Quote(watchdog) & " --workspace " & Quote(workspace) & """"

' 0 = hidden window, True = wait for this watchdog tick to finish.
shell.Run command, 0, True

Function Quote(value)
    Quote = """" & Replace(value, """", "\""") & """"
End Function
