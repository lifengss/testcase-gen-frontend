# 无人值守修复验证运行器：重启 BFF(GIT_MOCK=1) 后跑全量回归
# 用法：powershell -ExecutionPolicy Bypass -File _run_fix_verify.ps1
$ErrorActionPreference = 'Continue'
$ROOT = 'd:/self_coding/knowledgeOS/testcase-gen-frontend'
$KS = 'd:/self_coding/knowledgeOS/test-knowledge-system'
$timestamp = (Get-Date -Format 'yyyyMMdd-HHmmss')

function Log($msg) {
  $line = "[$(Get-Date -Format 'HH:mm:ss')] $msg"
  Write-Host $line
  Add-Content -Path "$ROOT/tests/full-suite/_fix_verify.log" -Value $line
}

Log "===== 修复验证开始 $timestamp ====="

# 1) 确认 KS(:3000) 存活
try {
  $ksHealth = Invoke-RestMethod -Uri 'http://localhost:3000/api/health' -TimeoutSec 5 -ErrorAction Stop
  Log "KS 存活: $($ksHealth.success)"
} catch {
  Log "KS 未存活，尝试启动..."
  Start-Process -FilePath 'cmd' -ArgumentList '/c','cd /d '+($KS -replace '/','\')+' && python api/server.py > ks_run.log 2>&1' -WindowStyle Hidden
  Start-Sleep -Seconds 8
}

# 2) 重启 BFF(4123)，显式注入 GIT_MOCK=1 使子进程继承环境变量（应用 C1 修复）
$env:GIT_MOCK = '1'
Log "GIT_MOCK 已设为: $env:GIT_MOCK"
# 结束旧 BFF
$bffProc = Get-Process -Name 'node' -ErrorAction SilentlyContinue | Where-Object { $_.CommandLine -like '*server/index.js*' }
if ($bffProc) {
  $bffProc | Stop-Process -Force -ErrorAction SilentlyContinue
  Log "已停止旧 BFF 进程"
  Start-Sleep -Seconds 2
}
$psi = New-Object System.Diagnostics.ProcessStartInfo
$psi.FileName = 'node'
$psi.Arguments = "$ROOT/server/index.js"
$psi.WorkingDirectory = $ROOT
$psi.UseShellExecute = $false
$psi.EnvironmentVariables['GIT_MOCK'] = '1'
$psi.RedirectStandardOutput = $false
[System.Diagnostics.Process]::Start($psi) | Out-Null
Log "已启动 BFF(GIT_MOCK=1)"
Start-Sleep -Seconds 4

# 验证 BFF 已应用修复：GIT_MOCK 生效 + 默认 project 一致
try {
  $gitCommit = Invoke-RestMethod -Uri 'http://localhost:4123/api/git/commit' -Method POST -Body '{}' -ContentType 'application/json' -TimeoutSec 5
  Log "BFF /api/git/commit mocked=$($gitCommit._mock) project=$($gitCommit.project)"
} catch {
  Log "BFF 连通校验失败: $_"
}

# 3) L1 KS 单元/契约回归（位于 tests/comprehensive/）
Log "--- L1: KS regression/feature/gbrain ---"
Push-Location $KS
cmd /c "node tests/comprehensive/regression-tests.cjs > tests/_reg_l1_regression.out 2>&1" 2>&1 | Out-Null
cmd /c "node tests/comprehensive/feature-tests.cjs > tests/_reg_l1_feature.out 2>&1" 2>&1 | Out-Null
cmd /c "node tests/comprehensive/gbrain-bge-coupling-test.cjs > tests/_reg_l1_gbrain.out 2>&1" 2>&1 | Out-Null
Pop-Location

# 4) L2 REST 冒烟
Log "--- L2: smoke ---"
Push-Location $KS
cmd /c "node tests/_reg_l2_smoke.cjs > tests/_reg_l2_smoke.out 2>&1" 2>&1 | Out-Null
Pop-Location

# 5) L3 Playwright UI
Log "--- L3: UI git/promote/gbrain ---"
Push-Location $KS
cmd /c "node tests/ui-git-test.cjs > tests/_reg_l3_git.out 2>&1" 2>&1 | Out-Null
cmd /c "node tests/ui-r23-promote-test.cjs > tests/_reg_l3_promote.out 2>&1" 2>&1 | Out-Null
cmd /c "node tests/ui-gbrain-bge-test.cjs > tests/_reg_l3_gbrain.out 2>&1" 2>&1 | Out-Null
Pop-Location

# 6) L4 TCGF 全量整合（含 A/B/C/D/DOC/UI）
Log "--- L4: TCGF comprehensive ---"
Push-Location "$ROOT/tests/full-suite"
cmd /c "node run-all-comprehensive.cjs > run.err 2>&1" 2>&1 | Out-Null
Pop-Location

# 7) 汇总关键结果
Log "--- 结果汇总 ---"
function Extract($f, $re) {
  if (-not (Test-Path $f)) { return 'see file (缺失)' }
  $c = Get-Content $f -Raw
  if ($c -match $re) {
    $parts = @()
    for ($i = 1; $i -le $Matches.Count - 1; $i++) { $parts += $Matches[$i] }
    return ($parts -join ' ')
  }
  return 'see file'
}
Log ("L1 regression : PASS=" + (Extract "$KS/tests/_reg_l1_regression.out" 'PASS=(\d+)'))
Log ("L1 feature    : PASS=" + (Extract "$KS/tests/_reg_l1_feature.out" 'PASS=(\d+)'))
Log ("L1 gbrain     : " + (Extract "$KS/tests/_reg_l1_gbrain.out" 'PASS=(\d+)[^\n]*FAIL=(\d+)'))
Log ("L2 smoke      : PASS=" + (Extract "$KS/tests/_reg_l2_smoke.out" 'PASS=(\d+)'))
Log ("L3 git        : PASS=" + (Extract "$KS/tests/_reg_l3_git.out" 'PASS=(\d+)'))
Log ("L3 promote    : PASS=" + (Extract "$KS/tests/_reg_l3_promote.out" 'PASS=(\d+)'))
Log ("L3 gbrain     : PASS=" + (Extract "$KS/tests/_reg_l3_gbrain.out" 'PASS=(\d+)'))
Log ("L4 comprehensive: " + (Extract "$ROOT/tests/full-suite/run.err" 'PASS=(\d+)[^\n]*FAIL=(\d+)[^\n]*WARN=(\d+)[^\n]*INFO=(\d+)'))

Log "===== 修复验证完成 $timestamp ====="
