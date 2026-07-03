' Hidden launcher for the HeyARP worker metrics logger.
' Task Scheduler starts this script with wscript.exe, which has no console window.

Option Explicit

Dim shell, fso, scriptDir, metricsScript, i, command, forwardedArgs

Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")

scriptDir = fso.GetParentFolderName(WScript.ScriptFullName)
metricsScript = fso.BuildPath(scriptDir, "arp-worker-metrics-logger.js")
forwardedArgs = ""

For i = 0 To WScript.Arguments.Count - 1
    forwardedArgs = forwardedArgs & " " & Quote(WScript.Arguments(i))
Next

command = "cmd.exe /d /s /c ""node " & Quote(metricsScript) & forwardedArgs & """"
shell.Run command, 0, True

Function Quote(value)
    Quote = """" & Replace(value, """", "\""") & """"
End Function
