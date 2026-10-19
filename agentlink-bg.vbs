' AgentLink background starter - resolves its own folder, runs the launcher hidden.
' Logs to client\agentlink.log so boot-time failures are diagnosable.
Dim fso, shell, dir
Set fso = CreateObject("Scripting.FileSystemObject")
dir = fso.GetParentFolderName(WScript.ScriptFullName)
Set shell = CreateObject("WScript.Shell")
shell.Run "cmd /c echo ==== %date% %time% ==== >> """ & dir & "\client\agentlink.log"" && cd /d """ & dir & "\client"" && npm run agentlink >> """ & dir & "\client\agentlink.log"" 2>&1", 0, False
