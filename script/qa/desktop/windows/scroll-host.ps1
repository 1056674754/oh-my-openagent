# Hosts a WinForms window whose multi-line TextBox (a Win32 EDIT underneath) holds a long document,
# scrolled to its middle so a wheel step either way moves it, for the scroll-direction scenarios of
# script/qa/desktop/windows.ts. Prints `ready <hwnd>` once the window is shown and runs until the
# driver kills it. Run with `powershell.exe -STA`.
param([Parameter(Mandatory = $true)][string]$Title, [int]$Lines = 200, [int]$FirstVisibleLine = 100)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

Add-Type -AssemblyName System.Windows.Forms
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class QaScrollHost {
	[DllImport("user32.dll")] public static extern IntPtr SendMessageW(IntPtr hwnd, uint msg, IntPtr wParam, IntPtr lParam);
}
'@

$box = New-Object System.Windows.Forms.TextBox -Property @{
	Multiline = $true; ReadOnly = $true; WordWrap = $false; ScrollBars = 'Vertical'; Dock = 'Fill'
}
$box.Lines = [string[]](1..$Lines | ForEach-Object { 'line {0:D3}' -f $_ })
$form = New-Object System.Windows.Forms.Form -Property @{
	Text = $Title; Width = 420; Height = 320; StartPosition = 'CenterScreen'
}
$form.Controls.Add($box)
$form.Add_Shown({
	# EM_LINESCROLL down by FirstVisibleLine lines leaves that zero-based line at the top.
	[void][QaScrollHost]::SendMessageW($box.Handle, 0x00B6, [IntPtr]::Zero, [IntPtr]$FirstVisibleLine)
	[Console]::Out.WriteLine("ready $($form.Handle.ToInt64())")
	[Console]::Out.Flush()
})
[System.Windows.Forms.Application]::Run($form)
