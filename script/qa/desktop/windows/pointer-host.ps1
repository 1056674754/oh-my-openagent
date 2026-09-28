# Hosts a WinForms window for the foreground pointer scenarios of script/qa/desktop/windows.ts: a
# multi-line read-only TextBox (a Win32 EDIT underneath) filling the client area, holding a long
# document opened at zero-based line $FirstVisibleLine, placed at an exact screen rect so two hosts can
# overlap. Every mouse button, wheel and activation event the window sees is appended to $EventLog with
# the screen point it happened at, so a scenario can tell which window a click, drag or wheel reached.
# Prints `ready <form hwnd> <edit hwnd>` once shown; runs until the driver kills it.
# Run with `powershell.exe -STA`.
param(
	[Parameter(Mandatory = $true)][string]$Title,
	[Parameter(Mandatory = $true)][string]$EventLog,
	[Parameter(Mandatory = $true)][int]$Left,
	[Parameter(Mandatory = $true)][int]$Top,
	[int]$Width = 480,
	[int]$Height = 360,
	[int]$Lines = 200,
	[int]$FirstVisibleLine = 100
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class QaPointerHost {
	[DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr value);
	[DllImport("user32.dll")] public static extern IntPtr SendMessageW(IntPtr hwnd, uint msg, IntPtr wParam, IntPtr lParam);
}
'@
# Per-monitor-v2 before any window exists, so the rect and logged points are physical pixels like the
# engine's and the probe's.
[void][QaPointerHost]::SetProcessDpiAwarenessContext([IntPtr]-4)
Add-Type -AssemblyName System.Windows.Forms
# Every mouse, paint, focus, activation and key message the form and its EDIT receive, stamped with the
# QPC counter (Stopwatch.GetTimestamp), so a scenario can line the host's view up with the engine's.
Add-Type -IgnoreWarnings -ReferencedAssemblies System.Windows.Forms -TypeDefinition @'
using System;
using System.Diagnostics;
using System.IO;
using System.Windows.Forms;
public class QaMessageLog : NativeWindow {
	readonly string path;
	readonly string name;
	public QaMessageLog(IntPtr handle, string path, string name) { this.path = path; this.name = name; AssignHandle(handle); }
	protected override void WndProc(ref Message m) {
		switch (m.Msg) {
			case 0x0006: case 0x0007: case 0x0008: case 0x000F: case 0x0021: case 0x0086: case 0x0100: case 0x0101:
			case 0x0200: case 0x0201: case 0x0202: case 0x020A: case 0x0215:
				File.AppendAllText(path, String.Format("msg {0} {1:X} {2} {3:X} {4:X}\n", name, m.Msg, Stopwatch.GetTimestamp(), m.WParam.ToInt64(), m.LParam.ToInt64()));
				break;
		}
		base.WndProc(ref m);
	}
}
'@

$box = New-Object System.Windows.Forms.TextBox -Property @{
	Multiline = $true; ReadOnly = $true; WordWrap = $false; ScrollBars = 'Vertical'; Dock = 'Fill'; HideSelection = $false
}
$box.Lines = [string[]](1..$Lines | ForEach-Object { 'line {0:D3} of the omo pointer host' -f $_ })
$form = New-Object System.Windows.Forms.Form -Property @{
	Text = $Title; StartPosition = 'Manual'; Left = $Left; Top = $Top; Width = $Width; Height = $Height
}
$form.Controls.Add($box)

function Write-HostEvent([string]$line) { [System.IO.File]::AppendAllText($EventLog, "$line`n") }
function Get-ScreenPoint($mouse) { $box.PointToScreen($mouse.Location) }
$box.Add_MouseDown({ param($source, $mouse) $at = Get-ScreenPoint $mouse; Write-HostEvent "mousedown $($mouse.Button) $($at.X) $($at.Y)" })
$box.Add_MouseUp({ param($source, $mouse) $at = Get-ScreenPoint $mouse; Write-HostEvent "mouseup $($mouse.Button) $($at.X) $($at.Y)" })
$box.Add_MouseWheel({ param($source, $mouse) $at = Get-ScreenPoint $mouse; Write-HostEvent "wheel $($mouse.Delta) $($at.X) $($at.Y)" })
$form.Add_Activated({ Write-HostEvent 'activated' })
$form.Add_Shown({
	$script:formLog = New-Object QaMessageLog -ArgumentList $form.Handle, $EventLog, 'form'
	$script:boxLog = New-Object QaMessageLog -ArgumentList $box.Handle, $EventLog, 'edit'
	# EM_LINESCROLL down by FirstVisibleLine lines leaves that zero-based line at the top.
	[void][QaPointerHost]::SendMessageW($box.Handle, 0x00B6, [IntPtr]::Zero, [IntPtr]$FirstVisibleLine)
	# EM_SETSEL 0,0: no selection, so a drag's selection is the only one.
	[void][QaPointerHost]::SendMessageW($box.Handle, 0x00B1, [IntPtr]::Zero, [IntPtr]::Zero)
	[Console]::Out.WriteLine("ready $($form.Handle.ToInt64()) $($box.Handle.ToInt64())")
	[Console]::Out.Flush()
})
[System.Windows.Forms.Application]::Run($form)
