[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)

$apiPort = 8787
$webPort = 5173
$hostAddress = '127.0.0.1'
$repositoryRoot = Split-Path -Parent $PSScriptRoot

function Get-PortListeners {
  param([Parameter(Mandatory)][int]$Port)

  @(Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction SilentlyContinue |
    Select-Object LocalAddress, LocalPort, OwningProcess)
}

function Test-SmartHubApi {
  try {
    $health = Invoke-RestMethod -Uri "http://${hostAddress}:${apiPort}/api/health" -TimeoutSec 3
    return $health.status -eq 'ok'
  } catch {
    return $false
  }
}

function Test-SmartHubWeb {
  try {
    $response = Invoke-WebRequest -Uri "http://${hostAddress}:${webPort}" -TimeoutSec 3 -UseBasicParsing
    return $response.StatusCode -eq 200 -and
      $response.Content -match '<title>SmartHub(?:\s|·)' -and
      $response.Content -match 'id="root"'
  } catch {
    return $false
  }
}

function Format-PortOwners {
  param([Parameter(Mandatory)][object[]]$Listeners)

  $processes = Get-CimInstance Win32_Process
  @($Listeners | ForEach-Object {
    $listener = $_
    $process = $processes | Where-Object { $_.ProcessId -eq $listener.OwningProcess } | Select-Object -First 1
    [pscustomobject]@{
      Port = $listener.LocalPort
      ProcessId = $listener.OwningProcess
      Process = $process.Name ?? 'unknown'
      Command = $process.CommandLine ?? 'unavailable'
    }
  })
}

$apiListeners = Get-PortListeners -Port $apiPort
$webListeners = Get-PortListeners -Port $webPort
$occupiedListeners = @($apiListeners) + @($webListeners)

if ($occupiedListeners.Count -gt 0) {
  if ($apiListeners.Count -gt 0 -and $webListeners.Count -gt 0 -and (Test-SmartHubApi) -and (Test-SmartHubWeb)) {
    Write-Host "SmartHub 开发实例已在运行：http://${hostAddress}:${webPort}（API ${hostAddress}:${apiPort}）。"
    Write-Host '本次未启动新的 API、Worker 或 Web，避免重复 Worker 和端口冲突。'
    Format-PortOwners -Listeners $occupiedListeners | Format-Table -AutoSize | Out-Host
    exit 0
  }

  [Console]::Error.WriteLine('SmartHub 开发服务未启动：所需端口已被其他或不完整的进程占用。')
  Format-PortOwners -Listeners $occupiedListeners | Format-Table -AutoSize | Out-Host
  [Console]::Error.WriteLine('请先在原终端停止占用进程，再重新执行 npm run dev。不会自动终止进程，以免中断运行中的任务。')
  exit 1
}

$concurrentlyEntrypoint = Join-Path $repositoryRoot 'node_modules\concurrently\dist\bin\concurrently.js'
$viteEntrypoint = Join-Path $repositoryRoot 'node_modules\vite\bin\vite.js'
if (-not (Test-Path -LiteralPath $concurrentlyEntrypoint) -or -not (Test-Path -LiteralPath $viteEntrypoint)) {
  throw '缺少开发依赖，请先执行 npm install。'
}

Set-Location -LiteralPath $repositoryRoot
Write-Host "正在启动 SmartHub：http://${hostAddress}:${webPort}（API ${hostAddress}:${apiPort}）"
Write-Host 'Worker 使用稳定进程，不随源码变更自动重启；请在没有运行中任务时重启开发服务以加载 Worker 代码变更。'

& node $concurrentlyEntrypoint `
  '--kill-others' `
  '--names' 'API,WORKER,WEB' `
  'node --watch --import tsx server/http/server.ts' `
  'node --import tsx server/worker.ts' `
  "node `"$viteEntrypoint`" --host $hostAddress --port $webPort --strictPort"

if ($LASTEXITCODE -ne 0) {
  exit $LASTEXITCODE
}
