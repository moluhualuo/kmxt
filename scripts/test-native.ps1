[CmdletBinding()]
param(
    [string]$MsysRoot = 'D:\exploitation\msys2'
)

$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$mingwRoot = Join-Path $MsysRoot 'mingw64'
$compiler = Join-Path $mingwRoot 'bin\g++.exe'
$archiver = Join-Path $mingwRoot 'bin\ar.exe'
$output = Join-Path $projectRoot '.runtime\native-test'
$cppRoot = Join-Path $projectRoot 'sdk\android\kmxt-sdk\src\main\cpp'

foreach ($tool in @($compiler, $archiver)) {
    if (-not (Test-Path -LiteralPath $tool)) {
        throw "Required Native tool was not found: $tool"
    }
}
if (-not (Test-Path -LiteralPath (Join-Path $mingwRoot 'include\nlohmann\json.hpp'))) {
    throw 'nlohmann/json is missing; install mingw-w64-x86_64-nlohmann-json in MSYS2.'
}

New-Item -ItemType Directory -Path $output -Force | Out-Null
$common = @('-std=c++17', '-Wall', '-Wextra', '-Werror', "-I$(Join-Path $cppRoot 'include')")

# Author: 花落. Distributed under the MIT License.
& $compiler @common -c (Join-Path $cppRoot 'canonical_json.cpp') -o (Join-Path $output 'canonical_json.o')
if ($LASTEXITCODE -ne 0) { throw 'canonical_json.cpp compilation failed.' }
& $compiler @common -c (Join-Path $cppRoot 'crypto.cpp') -o (Join-Path $output 'crypto.o')
if ($LASTEXITCODE -ne 0) { throw 'crypto.cpp compilation failed.' }

$library = Join-Path $output 'libkmxt_core.a'
& $archiver rcs $library (Join-Path $output 'canonical_json.o') (Join-Path $output 'crypto.o')
if ($LASTEXITCODE -ne 0) { throw 'Static library creation failed.' }

$executable = Join-Path $output 'kmxt_core_test.exe'
& $compiler @common (Join-Path $cppRoot 'tests\core_test.cpp') $library "-L$(Join-Path $mingwRoot 'lib')" -lcrypto -o $executable
if ($LASTEXITCODE -ne 0) { throw 'Native test linking failed.' }

$env:PATH = "$(Join-Path $mingwRoot 'bin');$env:PATH"
& $executable
if ($LASTEXITCODE -ne 0) { throw "Native vectors failed with exit code $LASTEXITCODE." }
Write-Output 'NATIVE_CORE_VECTORS_OK'
