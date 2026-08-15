[CmdletBinding()]
param(
    [string]$BaseUrl = 'http://127.0.0.1:8080',
    [string]$Username,
    [string]$Password,
    [string]$Path = '/admin/',
    [switch]$Public,
    [string]$StoreOrderNo,
    [string]$StoreQueryCode,
    [ValidateRange(320, 3840)]
    [int]$Width = 1440,
    [ValidateRange(480, 2160)]
    [int]$Height = 900,
    [ValidateSet('system', 'light', 'dark')]
    [string]$Theme = 'system',
    [string]$HoverSelector,
    [string]$Screenshot = '.runtime/ui-smoke.png'
)

$ErrorActionPreference = 'Stop'
if (-not $Public -and ([string]::IsNullOrWhiteSpace($Username) -or [string]::IsNullOrWhiteSpace($Password))) {
    throw 'Username and Password are required unless -Public is used.'
}
if (-not $Path.StartsWith('/')) {
    throw 'Path must begin with /.'
}
$projectRoot = Split-Path -Parent $PSScriptRoot
$runtimeRoot = Join-Path $projectRoot '.runtime'
New-Item -ItemType Directory -Path $runtimeRoot -Force | Out-Null

$chromeCandidates = @(
    'C:\Program Files\Google\Chrome\Application\chrome.exe',
    'C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe'
)
$chrome = $chromeCandidates | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
if (-not $chrome) {
    throw 'Chrome or Microsoft Edge was not found.'
}

if (-not [System.IO.Path]::IsPathRooted($Screenshot)) {
    $Screenshot = Join-Path $projectRoot $Screenshot
}
New-Item -ItemType Directory -Path (Split-Path -Parent $Screenshot) -Force | Out-Null

function Send-CdpCommand {
    param(
        [System.Net.WebSockets.ClientWebSocket]$Socket,
        [int]$Id,
        [string]$Method,
        [hashtable]$Parameters = @{}
    )

    $request = @{ id = $Id; method = $Method; params = $Parameters } | ConvertTo-Json -Depth 12 -Compress
    $bytes = [System.Text.Encoding]::UTF8.GetBytes($request)
    $segment = [System.ArraySegment[byte]]::new($bytes)
    $null = $Socket.SendAsync(
        $segment,
        [System.Net.WebSockets.WebSocketMessageType]::Text,
        $true,
        [System.Threading.CancellationToken]::None
    ).GetAwaiter().GetResult()

    while ($true) {
        $stream = [System.IO.MemoryStream]::new()
        do {
            $buffer = [byte[]]::new(65536)
            $receiveSegment = [System.ArraySegment[byte]]::new($buffer)
            $received = $Socket.ReceiveAsync(
                $receiveSegment,
                [System.Threading.CancellationToken]::None
            ).GetAwaiter().GetResult()
            if ($received.MessageType -eq [System.Net.WebSockets.WebSocketMessageType]::Close) {
                throw 'Chrome DevTools connection closed unexpectedly.'
            }
            $stream.Write($buffer, 0, $received.Count)
        } while (-not $received.EndOfMessage)

        $messageText = [System.Text.Encoding]::UTF8.GetString($stream.ToArray())
        $message = $messageText | ConvertFrom-Json
        if ($message.id -eq $Id) {
            if ($message.error) {
                throw "CDP $Method failed: $($message.error.message)"
            }
            return $message
        }
    }
}

function Invoke-CdpExpression {
    param(
        [System.Net.WebSockets.ClientWebSocket]$Socket,
        [ref]$Sequence,
        [string]$Expression
    )
    $Sequence.Value += 1
    $response = Send-CdpCommand -Socket $Socket -Id $Sequence.Value -Method 'Runtime.evaluate' -Parameters @{
        expression = $Expression
        returnByValue = $true
        awaitPromise = $true
    }
    if ($response.result.exceptionDetails) {
        throw "Browser expression failed: $($response.result.exceptionDetails.text)"
    }
    return $response.result.result.value
}

# Author: 花落. UI verification tooling is distributed under the MIT License.
$port = Get-Random -Minimum 9300 -Maximum 9900
$userDataDirectory = Join-Path $runtimeRoot "chrome-smoke-$port"
$browser = $null
$socket = $null
try {
    $arguments = @(
        '--headless=new',
        '--disable-gpu',
        '--disable-extensions',
        '--no-first-run',
        '--remote-allow-origins=*',
        "--remote-debugging-port=$port",
        "--user-data-dir=$userDataDirectory",
        'about:blank'
    )
    $browser = Start-Process -FilePath $chrome -ArgumentList $arguments -WindowStyle Hidden -PassThru

    $target = $null
    for ($attempt = 0; $attempt -lt 80; $attempt += 1) {
        try {
            $target = Invoke-RestMethod -Method Put -Uri "http://127.0.0.1:$port/json/new?about%3Ablank"
            break
        } catch {
            Start-Sleep -Milliseconds 100
        }
    }
    if (-not $target) {
        throw 'Chrome DevTools endpoint did not become ready.'
    }

    $socket = [System.Net.WebSockets.ClientWebSocket]::new()
    $null = $socket.ConnectAsync(
        [System.Uri]$target.webSocketDebuggerUrl,
        [System.Threading.CancellationToken]::None
    ).GetAwaiter().GetResult()
    $sequence = 0
    $sequence += 1
    $null = Send-CdpCommand -Socket $socket -Id $sequence -Method 'Runtime.enable'
    $sequence += 1
    $null = Send-CdpCommand -Socket $socket -Id $sequence -Method 'Page.enable'
    $sequence += 1
    $null = Send-CdpCommand -Socket $socket -Id $sequence -Method 'Emulation.setDeviceMetricsOverride' -Parameters @{
        width = $Width
        height = $Height
        deviceScaleFactor = 1
        mobile = ($Width -lt 820)
        screenWidth = $Width
        screenHeight = $Height
    }
    $sequence += 1
    $null = Send-CdpCommand -Socket $socket -Id $sequence -Method 'Page.navigate' -Parameters @{
        url = "$($BaseUrl.TrimEnd('/'))$Path"
    }

    for ($attempt = 0; $attempt -lt 80; $attempt += 1) {
        $ready = Invoke-CdpExpression -Socket $socket -Sequence ([ref]$sequence) -Expression 'document.readyState'
        $readyElement = if ($Public) {
            Invoke-CdpExpression -Socket $socket -Sequence ([ref]$sequence) -Expression 'Boolean(document.querySelector("#store-app"))'
        } else {
            Invoke-CdpExpression -Socket $socket -Sequence ([ref]$sequence) -Expression 'Boolean(document.querySelector("#login-form"))'
        }
        if ($ready -eq 'complete' -and $readyElement) {
            break
        }
        Start-Sleep -Milliseconds 100
    }

    if (-not $Public) {
        $usernameJson = $Username | ConvertTo-Json -Compress
        $passwordJson = $Password | ConvertTo-Json -Compress
        $loginExpression = @"
(() => {
  const username = document.querySelector('#login-username');
  const password = document.querySelector('#login-password');
  const form = document.querySelector('#login-form');
  if (!username || !password || !form) return false;
  username.value = $usernameJson;
  password.value = $passwordJson;
  form.requestSubmit();
  return true;
})()
"@
        $submitted = Invoke-CdpExpression -Socket $socket -Sequence ([ref]$sequence) -Expression $loginExpression
        if (-not $submitted) {
            throw 'Login form was not available.'
        }

        $loggedIn = $false
        for ($attempt = 0; $attempt -lt 100; $attempt += 1) {
            $loggedIn = Invoke-CdpExpression -Socket $socket -Sequence ([ref]$sequence) -Expression 'Boolean(document.querySelector(".app-shell"))'
            if ($loggedIn) {
                break
            }
            Start-Sleep -Milliseconds 100
        }
        if (-not $loggedIn) {
            $loginError = Invoke-CdpExpression -Socket $socket -Sequence ([ref]$sequence) -Expression 'document.querySelector("#login-error")?.textContent || ""'
            throw "UI login failed: $loginError"
        }
    } else {
        for ($attempt = 0; $attempt -lt 100; $attempt += 1) {
            $publicReady = Invoke-CdpExpression -Socket $socket -Sequence ([ref]$sequence) -Expression '!document.querySelector(".store-loading")'
            if ($publicReady) {
                break
            }
            Start-Sleep -Milliseconds 100
        }
        if (-not [string]::IsNullOrWhiteSpace($StoreOrderNo) -or -not [string]::IsNullOrWhiteSpace($StoreQueryCode)) {
            if ([string]::IsNullOrWhiteSpace($StoreOrderNo) -or [string]::IsNullOrWhiteSpace($StoreQueryCode)) {
                throw 'StoreOrderNo and StoreQueryCode must be provided together.'
            }
            $orderNoJson = $StoreOrderNo | ConvertTo-Json -Compress
            $queryCodeJson = $StoreQueryCode | ConvertTo-Json -Compress
            $switchViewExpression = @"
(() => {
  location.hash = 'orders';
  return true;
})()
"@
            $null = Invoke-CdpExpression -Socket $socket -Sequence ([ref]$sequence) -Expression $switchViewExpression
            $queryFormReady = $false
            for ($attempt = 0; $attempt -lt 50; $attempt += 1) {
                $queryFormReady = Invoke-CdpExpression -Socket $socket -Sequence ([ref]$sequence) -Expression 'Boolean(document.querySelector("#order-query-form"))'
                if ($queryFormReady) {
                    break
                }
                Start-Sleep -Milliseconds 100
            }
            if (-not $queryFormReady) {
                throw 'Store order query form was not available.'
            }
            $queryExpression = @"
(() => {
  const form = document.querySelector('#order-query-form');
  const orderNo = document.querySelector('#query-order-no');
  const queryCode = document.querySelector('#query-code');
  if (!form || !orderNo || !queryCode) return false;
  orderNo.value = $orderNoJson;
  queryCode.value = $queryCodeJson;
  form.requestSubmit();
  return true;
})()
"@
            $querySubmitted = Invoke-CdpExpression -Socket $socket -Sequence ([ref]$sequence) -Expression $queryExpression
            if (-not $querySubmitted) {
                throw 'Store order query form could not be submitted.'
            }
            $queryComplete = $false
            for ($attempt = 0; $attempt -lt 100; $attempt += 1) {
                $queryComplete = Invoke-CdpExpression -Socket $socket -Sequence ([ref]$sequence) -Expression 'Boolean(document.querySelector(".license-delivery, .order-result .form-error.visible"))'
                if ($queryComplete) {
                    break
                }
                Start-Sleep -Milliseconds 100
            }
            if (-not $queryComplete) {
                throw 'Store order query did not reach a completed state.'
            }
        }
    }

    if ($Theme -ne 'system') {
        $themeJson = $Theme | ConvertTo-Json -Compress
        $themeExpression = @"
(() => {
  const expected = $themeJson;
  const button = document.querySelector('[data-theme-toggle]');
  if (!button) return { error: 'toggle-missing' };
  if (document.documentElement.dataset.theme !== expected) {
    button.click();
  } else if (localStorage.getItem('kmxt.theme') !== expected) {
    button.click();
    button.click();
  }
  return {
    theme: document.documentElement.dataset.theme,
    stored: localStorage.getItem('kmxt.theme'),
    pressed: button.getAttribute('aria-pressed')
  };
})()
"@
        $themeResult = Invoke-CdpExpression -Socket $socket -Sequence ([ref]$sequence) -Expression $themeExpression
        if ($themeResult.error -or $themeResult.theme -ne $Theme -or $themeResult.stored -ne $Theme) {
            throw "Theme switch failed: expected $Theme."
        }
    }

    $hoverState = $null
    if (-not [string]::IsNullOrWhiteSpace($HoverSelector)) {
        $hoverSelectorJson = $HoverSelector | ConvertTo-Json -Compress
        $hoverRectExpression = @"
(() => {
  const element = document.querySelector($hoverSelectorJson);
  if (!element) return null;
  const rect = element.getBoundingClientRect();
  return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
})()
"@
        $hoverRect = Invoke-CdpExpression -Socket $socket -Sequence ([ref]$sequence) -Expression $hoverRectExpression
        if (-not $hoverRect) {
            throw "Hover target was not available: $HoverSelector"
        }
        $sequence += 1
        $null = Send-CdpCommand -Socket $socket -Id $sequence -Method 'Input.dispatchMouseEvent' -Parameters @{
            type = 'mouseMoved'
            x = $hoverRect.x
            y = $hoverRect.y
        }
        Start-Sleep -Milliseconds 250
        $hoverStateExpression = @"
(() => {
  const element = document.querySelector($hoverSelectorJson);
  if (!element) return null;
  const style = getComputedStyle(element);
  return { backgroundColor: style.backgroundColor, color: style.color };
})()
"@
        $hoverState = Invoke-CdpExpression -Socket $socket -Sequence ([ref]$sequence) -Expression $hoverStateExpression
    }

    Start-Sleep -Milliseconds 300
    $metricsExpression = @'
JSON.stringify((() => {
  const rect = (selector) => {
    const element = document.querySelector(selector);
    if (!element) return null;
    const value = element.getBoundingClientRect();
    return { x: value.x, y: value.y, width: value.width, height: value.height };
  };
  return {
    viewport: { width: innerWidth, height: innerHeight },
    document: { width: document.documentElement.scrollWidth, height: document.documentElement.scrollHeight },
    horizontalOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth,
    sidebar: rect('.sidebar'),
    topbar: rect('.topbar'),
    content: rect('#main-content') || rect('#store-main'),
    pageTitle: document.querySelector('.page-header h1, .store-hero h1, .store-page-header h1, .store-error h1')?.textContent || null,
    theme: document.documentElement.dataset.theme || null,
    storedTheme: localStorage.getItem('kmxt.theme'),
    openDialogs: document.querySelectorAll('dialog[open]').length,
    busy: Boolean(document.querySelector('#busy-bar')) && !document.querySelector('#busy-bar').hidden
  };
})())
'@
    $metricsJson = Invoke-CdpExpression -Socket $socket -Sequence ([ref]$sequence) -Expression $metricsExpression
    $metrics = $metricsJson | ConvertFrom-Json
    if ($metrics.horizontalOverflow) {
        throw "UI has horizontal overflow at ${Width}x${Height}."
    }
    if ($metrics.busy -or -not $metrics.content) {
        throw 'UI did not reach a stable rendered state.'
    }

    $sequence += 1
    $capture = Send-CdpCommand -Socket $socket -Id $sequence -Method 'Page.captureScreenshot' -Parameters @{
        format = 'png'
        fromSurface = $true
        captureBeyondViewport = $false
    }
    [System.IO.File]::WriteAllBytes($Screenshot, [Convert]::FromBase64String($capture.result.data))

    if (-not $Public) {
        $logoutExpression = @'
(async () => {
  const token = sessionStorage.getItem('kmxt.admin.token');
  if (token) {
    await fetch('/api/v1/auth/logout', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: '{}'
    });
    sessionStorage.removeItem('kmxt.admin.token');
  }
  return true;
})()
'@
        $null = Invoke-CdpExpression -Socket $socket -Sequence ([ref]$sequence) -Expression $logoutExpression
    }
    $result = [pscustomobject]@{
        Passed = $true
        Width = $Width
        Height = $Height
        Screenshot = $Screenshot
        Metrics = $metrics
        Hover = $hoverState
    }
    $sequence += 1
    $null = Send-CdpCommand -Socket $socket -Id $sequence -Method 'Browser.close'
    Start-Sleep -Milliseconds 200
    $result | ConvertTo-Json -Depth 8
} finally {
    if ($socket) {
        $socket.Dispose()
    }
    if ($browser -and -not $browser.HasExited) {
        Stop-Process -Id $browser.Id -Force -ErrorAction SilentlyContinue
    }
    if (Test-Path -LiteralPath $userDataDirectory) {
        $resolvedRuntime = [System.IO.Path]::GetFullPath($runtimeRoot).TrimEnd('\') + '\'
        $resolvedUserData = [System.IO.Path]::GetFullPath($userDataDirectory)
        if ($resolvedUserData.StartsWith($resolvedRuntime, [System.StringComparison]::OrdinalIgnoreCase)) {
            Remove-Item -LiteralPath $resolvedUserData -Recurse -Force -ErrorAction SilentlyContinue
        }
    }
}
