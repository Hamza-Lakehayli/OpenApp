' AgentLink background starter - resolves its own folder, runs the launcher hidden
Dim fso, shell, dir
Set fso = CreateObject("Scripting.FileSystemObject")
dir = fso.GetParentFolderName(WScript.ScriptFullName)
Set shell = CreateObject("WScript.Shell")
shell.Run "cmd /c cd /d """ & dir & "\client"" && npm run agentlink", 0, False
