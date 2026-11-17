# Pixl File Manager - tiny local web server.
# Web Bluetooth only works on https:// or http://localhost pages, so this serves the
# app folder on http://localhost and opens it in Chrome or Edge.
# Only this computer can reach it. Close the window to stop it.

param(
    [int]$Port = 8642,
    [switch]$NoBrowser
)

$ErrorActionPreference = 'Stop'
$root = [IO.Path]::GetFullPath((Split-Path -Parent $MyInvocation.MyCommand.Path)).TrimEnd('\') + '\'

$listener = $null
for ($p = $Port; $p -lt $Port + 20; $p++) {
    try {
        $l = New-Object System.Net.HttpListener
        $l.Prefixes.Add("http://localhost:$p/")
        $l.Start()
        $listener = $l
        $Port = $p
        break
    } catch {
        $listener = $null
    }
}
if (-not $listener) {
    Write-Host "Could not start the local server (ports $Port-$($Port + 19) are busy)." -ForegroundColor Red
    Read-Host 'Press Enter to close'
    exit 1
}

$url = "http://localhost:$Port/"
Write-Host ''
Write-Host '  Pixl File Manager' -ForegroundColor Cyan
Write-Host "  Running at $url"
Write-Host '  Keep this window open while you use it. Close it to stop.'
Write-Host ''

if (-not $NoBrowser) {
    $candidates = @(
        "$env:ProgramFiles\Google\Chrome\Application\chrome.exe",
        "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe",
        "$env:LocalAppData\Google\Chrome\Application\chrome.exe",
        "${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe",
        "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe"
    )
    $browser = $candidates | Where-Object { $_ -and (Test-Path $_) } | Select-Object -First 1
    try {
        if ($browser) {
            # --app opens a clean window without tabs/address bar
            Start-Process -FilePath $browser -ArgumentList "--app=$url"
        } else {
            Start-Process "microsoft-edge:$url"
        }
    } catch {
        Write-Host "Open $url in Chrome or Edge." -ForegroundColor Yellow
    }
}

$mime = @{
    '.html' = 'text/html; charset=utf-8'
    '.js'   = 'text/javascript; charset=utf-8'
    '.css'  = 'text/css; charset=utf-8'
    '.svg'  = 'image/svg+xml'
    '.png'  = 'image/png'
    '.ico'  = 'image/x-icon'
    '.json' = 'application/json'
    '.md'   = 'text/plain; charset=utf-8'
}

try {
    while ($listener.IsListening) {
        $ctx = $listener.GetContext()
        $res = $ctx.Response
        try {
            $rel = [Uri]::UnescapeDataString($ctx.Request.Url.AbsolutePath).TrimStart('/')
            if ([string]::IsNullOrEmpty($rel)) { $rel = 'index.html' }
            $full = [IO.Path]::GetFullPath([IO.Path]::Combine($root, $rel))
            $ext = [IO.Path]::GetExtension($full).ToLowerInvariant()
            if ($full.StartsWith($root, [StringComparison]::OrdinalIgnoreCase) -and $mime.ContainsKey($ext) -and (Test-Path -LiteralPath $full -PathType Leaf)) {
                $bytes = [IO.File]::ReadAllBytes($full)
                $res.ContentType = $mime[$ext]
                $res.StatusCode = 200
            } else {
                $bytes = [Text.Encoding]::UTF8.GetBytes('Not found')
                $res.ContentType = 'text/plain'
                $res.StatusCode = 404
            }
            $res.Headers.Add('Cache-Control', 'no-store')
            $res.ContentLength64 = $bytes.Length
            $res.OutputStream.Write($bytes, 0, $bytes.Length)
        } catch {
            try { $res.StatusCode = 500 } catch {}
        } finally {
            try { $res.OutputStream.Close() } catch {}
        }
    }
} finally {
    $listener.Stop()
}
