#Requires -Version 5.1
<#
.SYNOPSIS
  Serve one directory over loopback, for the fleet installer's acceptance run.

.DESCRIPTION
  The guest has no network adapter, so the channel `tools/dsh-netbird/client/install.ps1`
  reads is served from inside the machine over the files the unattended media carries.

  This runs in its own process rather than as a PowerShell job: the answer file runs the
  acceptance from a non-interactive logon, and there the job infrastructure is not
  dependable - which is how a run ended with no verdict at all instead of a failure.
#>
param(
  [Parameter(Mandatory = $true)][string]$Root,
  [Parameter(Mandatory = $true)][int]$Port
)

$ErrorActionPreference = 'Stop'
$listener = New-Object System.Net.HttpListener
$listener.Prefixes.Add("http://127.0.0.1:$Port/")
$listener.Start()

while ($listener.IsListening) {
  try {
    $context = $listener.GetContext()
  } catch {
    break
  }
  $name = [System.IO.Path]::GetFileName($context.Request.Url.LocalPath)
  $path = Join-Path $Root $name
  if ($name -and (Test-Path $path -PathType Leaf)) {
    $bytes = [System.IO.File]::ReadAllBytes($path)
    $context.Response.ContentType = if ($name -like '*.gz') { 'application/octet-stream' } else { 'text/plain' }
    $context.Response.ContentLength64 = $bytes.Length
    $context.Response.OutputStream.Write($bytes, 0, $bytes.Length)
  } else {
    $context.Response.StatusCode = 404
  }
  $context.Response.Close()
}