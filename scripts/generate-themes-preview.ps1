# Reads theme data from src/themes.ts and writes assets/themes-preview.svg

$themesFile = Join-Path $PSScriptRoot '..\src\themes.ts'
$content    = Get-Content $themesFile -Raw

# Parse every  build('Name', '#primary', '#dark', '#fg', '#badge')  call
$pattern = "build\('([^']+)',\s*'([^']+)',\s*'([^']+)',\s*'([^']+)',\s*'([^']+)'\)"
$themes  = @(foreach ($m in [regex]::Matches($content, $pattern)) {
    [PSCustomObject]@{
        name    = $m.Groups[1].Value
        primary = $m.Groups[2].Value
        dark    = $m.Groups[3].Value
        fg      = $m.Groups[4].Value
        badge   = $m.Groups[5].Value
    }
})

$cols   = 4
$cardW  = 224   # includes gutter
$cardH  = 110
$width  = $cols * $cardW + 32
$rows   = [Math]::Ceiling([double]$themes.Count / $cols)
$height = [int]$rows * $cardH + 32

function Get-CardSvg {
    param([PSCustomObject]$t, [int]$ix)
    $col = $ix % $cols
    $row = [Math]::Floor($ix / $cols)
    $x   = 16 + $col * $cardW
    $y   = 16 + $row * $cardH
    @"

  <g transform="translate($x,$y)">
    <rect width="208" height="92" rx="8" fill="$($t.dark)" stroke="#00000010" />
    <!-- title bar -->
    <rect x="0" y="0" width="208" height="16" rx="8" fill="$($t.dark)" opacity="0.95" />
    <text x="9" y="11" font-size="10" fill="$($t.fg)" opacity="0.8">&#x25CF; &#x25CF; &#x25CF;</text>
    <!-- activity bar -->
    <rect x="0" y="16" width="32" height="56" fill="$($t.primary)" opacity="0.95" />
    <!-- editor area -->
    <rect x="32" y="16" width="176" height="56" fill="#11111122" />
    <!-- activity dots -->
    <rect x="12" y="32" width="8" height="8" rx="2" fill="$($t.fg)" />
    <rect x="12" y="52" width="8" height="8" rx="2" fill="$($t.fg)" opacity="0.4" />
    <rect x="12" y="72" width="8" height="8" rx="2" fill="$($t.fg)" opacity="0.4" />
    <!-- badge -->
    <circle cx="22" cy="54" r="3" fill="$($t.badge)" />
    <!-- status bar -->
    <rect x="0" y="68" width="208" height="24" fill="$($t.dark)" opacity="0.95" />
    <text x="12" y="86" font-family="system-ui,Segoe UI,Roboto,Arial" font-weight="600" font-size="16" fill="$($t.fg)">$($t.name)</text>
    <!-- subtle overlay -->
    <rect width="208" height="92" rx="8" fill="#000" opacity="0.12" />
  </g>
"@
}

$cards = for ($i = 0; $i -lt $themes.Count; $i++) { Get-CardSvg $themes[$i] $i }

$svg = @"
<?xml version="1.0"?>
<svg xmlns="http://www.w3.org/2000/svg" width="$width" height="$height" viewBox="0 0 $width $height">
$($cards -join "`n")
</svg>
"@

$outDir  = Join-Path $PSScriptRoot '..\assets'
New-Item -ItemType Directory -Path $outDir -Force | Out-Null
$outFile = Join-Path $outDir 'themes-preview.svg'
Set-Content -Path $outFile -Value $svg -Encoding utf8NoBOM
Write-Host "Wrote $outFile  ($($themes.Count) themes)"
