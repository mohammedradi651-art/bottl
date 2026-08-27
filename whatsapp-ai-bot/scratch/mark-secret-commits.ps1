param([string]$Path)

$todo = Get-Content -Raw -LiteralPath $Path
$todo = $todo -replace '(?m)^pick 6b94181 ', 'pick 6b94181 '
$todo = $todo -replace '(?m)^pick 358e620 ', 'pick 358e620 '
$todo = $todo -replace '(?m)^pick a0c3a40 ', 'break # pause before final commit'
Set-Content -LiteralPath $Path -Value $todo -Encoding utf8