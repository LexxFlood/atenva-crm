$ErrorActionPreference = 'Stop'

Set-Location -LiteralPath $PSScriptRoot

$docker = 'C:\Program Files\Docker\Docker\resources\bin\docker.exe'
$envFile = '.env.local'

if (-not (Test-Path -LiteralPath $docker)) {
  throw 'Docker Desktop não encontrado.'
}

if (-not (Test-Path -LiteralPath $envFile)) {
  $apiKey = -join ((1..64) | ForEach-Object { '{0:x}' -f (Get-Random -Maximum 16) })
  $dbPassword = -join ((1..48) | ForEach-Object { '{0:x}' -f (Get-Random -Maximum 16) })
  $template = Get-Content -Raw -LiteralPath '.env.local.example'
  $template = $template.Replace('SUBSTITUA_POR_64_CARACTERES_HEXADECIMAIS', $apiKey)
  $template = $template.Replace('SUBSTITUA_POR_UMA_SENHA_FORTE', $dbPassword)
  Set-Content -LiteralPath $envFile -Value $template -Encoding utf8NoBOM
}

& $docker compose --env-file $envFile -f docker-compose.local.yml pull
if ($LASTEXITCODE -ne 0) { throw 'Falha ao baixar as imagens Docker.' }

& $docker compose --env-file $envFile -f docker-compose.local.yml up -d
if ($LASTEXITCODE -ne 0) { throw 'Falha ao iniciar a Evolution local.' }

& $docker compose --env-file $envFile -f docker-compose.local.yml ps
