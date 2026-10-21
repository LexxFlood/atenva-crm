$ErrorActionPreference = 'Stop'

# Compatibilidade com a rotina anterior: a recuperação padrão agora usa o
# endereço estável do Tailscale e publica apenas o gateway protegido.
& (Join-Path $PSScriptRoot 'start-secure-funnel.ps1')
