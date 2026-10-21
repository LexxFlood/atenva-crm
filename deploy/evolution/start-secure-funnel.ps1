$ErrorActionPreference = 'Stop'

Set-Location -LiteralPath $PSScriptRoot

$docker = 'C:\Program Files\Docker\Docker\resources\bin\docker.exe'
$tailscale = 'C:\Program Files\Tailscale\tailscale.exe'
$envFile = Join-Path $PSScriptRoot '.env.local'

if (-not (Test-Path -LiteralPath $docker)) { throw 'Docker não encontrado.' }
if (-not (Test-Path -LiteralPath $tailscale)) { throw 'Tailscale não encontrado.' }
if (-not (Test-Path -LiteralPath $envFile)) { throw '.env.local da Evolution não encontrado.' }

& $docker compose --env-file $envFile -f docker-compose.local.yml up -d gateway
if ($LASTEXITCODE -ne 0) { throw 'Não foi possível iniciar o gateway seguro.' }

& $tailscale funnel --bg 8787
if ($LASTEXITCODE -ne 0) { throw 'Não foi possível ativar o Tailscale Funnel.' }

$status = & $tailscale funnel status
$publicUrl = [regex]::Match(($status -join "`n"), 'https://[^\s/]+').Value
if (-not $publicUrl) { throw 'O Tailscale não informou a URL pública.' }

[PSCustomObject]@{
  PublicUrl = $publicUrl
  LocalGateway = 'http://127.0.0.1:8787'
  Protection = 'API key + lista restrita de rotas'
}
