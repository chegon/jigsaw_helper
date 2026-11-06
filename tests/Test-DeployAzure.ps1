#Requires -Version 5.1
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$deploymentScript = Join-Path (Split-Path $PSScriptRoot -Parent) 'deploy-azure.ps1'
$deploymentEntry = Join-Path (Split-Path $PSScriptRoot -Parent) 'deploy.ps1'
$fixtureRoot = Join-Path ([System.IO.Path]::GetTempPath()) ('jigsaw-deploy-test-' + [guid]::NewGuid().ToString('N'))
$source = Join-Path $fixtureRoot 'dist'
$credentialFile = Join-Path $fixtureRoot 'fake-credentials.yaml'
$script:key = [Convert]::ToBase64String([byte[]] (1..64))
$script:connection = "DefaultEndpointsProtocol=https;AccountName=testjigsaw123;AccountKey=$script:key;EndpointSuffix=core.windows.net"
$script:calls = [System.Collections.Generic.List[object]]::new()
$script:webCalls = [System.Collections.Generic.List[string]]::new()
$script:testCount = 0
$global:LASTEXITCODE = 0
$previousMock = Get-Variable -Name JigsawDeploymentMock -Scope Global -ErrorAction SilentlyContinue
$script:mock = [pscustomobject]@{
    Key = $script:key
    Connection = $script:connection
    Calls = $script:calls
    WebCalls = $script:webCalls
    FailUpload = ''
    ErrorContext = ''
    WrongMetadata = ''
    MalformedJson = $false
    FailWebsite = $false
    InvalidWebsiteLength = $false
    FailBuild = $false
    BuildCalls = 0
    PrivacyChecks = 0
    FailPrivacy = $false
    RootDeleted = [System.Collections.Generic.List[string]]::new()
    RootWorkerUploaded = $false
    RootMissing = $false
    FailRootDelete = $false
    RootStillPublic = $false
    DefaultIndexFallback = $false
}
$global:JigsawDeploymentMock = $script:mock

function Assert-Test {
    param([bool] $Condition, [string] $Message)
    if (-not $Condition) { throw "TEST FAILED: $Message" }
}

function Get-TestArgument {
    param([object[]] $Arguments, [string] $Name)
    $position = [Array]::IndexOf($Arguments, $Name)
    if ($position -lt 0 -or $position + 1 -ge $Arguments.Count) { return $null }
    return [string] $Arguments[$position + 1]
}

function az {
    $state = $global:JigsawDeploymentMock
    $arguments = @($args)
    $state.Calls.Add($arguments)
    Assert-Test ($state.PrivacyChecks -gt 0) 'Azure was contacted before the private-data scan.'
    Assert-Test (-not ($arguments -contains '--account-name')) 'Account identifiers must not appear in command arguments.'
    Assert-Test (-not (($arguments -join ' ') -match [regex]::Escape($state.Key))) 'Key appeared in process arguments.'
    Assert-Test (-not ($arguments -contains '--connection-string')) 'Connection string must use the environment, not arguments.'
    Assert-Test ($env:AZURE_STORAGE_CONNECTION_STRING -ceq $state.Connection) 'Temporary connection-string environment was not provided.'
    Assert-Test ([string]::IsNullOrEmpty($env:AZURE_STORAGE_KEY)) 'A stale storage-key override was not cleared.'
    Assert-Test ([string]::IsNullOrEmpty($env:AZURE_STORAGE_SAS_TOKEN)) 'A stale SAS override was not cleared.'
    Assert-Test ([string]::IsNullOrEmpty($env:AZURE_STORAGE_SERVICE_ENDPOINT)) 'A stale endpoint override was not cleared.'
    Assert-Test ((Get-TestArgument $arguments '--auth-mode') -eq 'key') 'Explicit key auth was not requested.'
    Assert-Test ($arguments -contains '--only-show-errors') 'CLI noise was not suppressed.'
    $global:LASTEXITCODE = 0
    $command = $arguments[0..2] -join ' '
    if ($command -eq 'storage blob service-properties' -and $arguments[3] -eq 'show') {
        if ($state.DefaultIndexFallback) {
            return '{"staticWebsite":{"enabled":true,"defaultIndexDocumentPath":"fallback/index.html"}}'
        }
        return '{"staticWebsite":{"enabled":true,"indexDocument":"old.html","errorDocument404Path":"keep-404.html"}}'
    }
    if ($command -eq 'storage blob service-properties' -and $arguments[3] -eq 'update') {
        Assert-Test ((Get-TestArgument $arguments '--404-document') -eq 'keep-404.html') 'Existing custom 404 setting was lost.'
        Assert-Test ((Get-TestArgument $arguments '--index-document') -eq 'index.html') 'Index document was not set.'
        return
    }
    if ($command -eq 'storage container create') {
        Assert-Test ((Get-TestArgument $arguments '--name') -eq '$web') 'Wrong container.'
        Assert-Test ((Get-TestArgument $arguments '--public-access') -eq 'off') 'Blob container must not be made public.'
        return
    }
    if ($command -eq 'storage blob upload') {
        $name = Get-TestArgument $arguments '--name'
        if ($name -eq 'sw.js' -and (Get-TestArgument $arguments '--file') -like '*retire-root-sw.js') {
            $state.RootWorkerUploaded = $true
        }
        if ($name -eq $state.FailUpload) {
            $global:LASTEXITCODE = 1
            return "Simulated CLI failure with $($state.Connection) and standalone key $($state.Key). $($state.ErrorContext)"
        }
        Assert-Test ((Get-TestArgument $arguments '--overwrite') -eq 'true') 'Overwrite flag missing.'
        Assert-Test ($arguments -contains '--validate-content') 'Transport validation missing.'
        Assert-Test ((Get-TestArgument $arguments '--content-cache-control') -eq 'no-cache') 'Cache header missing.'
        return
    }
    if ($command -eq 'storage blob show') {
        if ($state.MalformedJson) { return "Invalid CLI output containing $($state.Key)" }
        $name = Get-TestArgument $arguments '--name'
        if ((Get-TestArgument $arguments '--query') -eq 'properties.etag') { return '"fixture-etag"' }
        $upload = @($state.Calls | Where-Object {
            $_[0] -eq 'storage' -and $_[1] -eq 'blob' -and $_[2] -eq 'upload' -and
            (Get-TestArgument $_ '--name') -eq $name
        })[-1]
        $type = Get-TestArgument $upload '--content-type'
        if ($name -eq $state.WrongMetadata) { $type = 'application/octet-stream' }
        return (@{
            length = (Get-Item -LiteralPath (Get-TestArgument $upload '--file')).Length
            type = $type
            cache = 'no-cache'
        } | ConvertTo-Json -Compress)
    }
    if ($command -eq 'storage blob exists') {
        if ($state.RootMissing) { return 'false' }
        return 'true'
    }
    if ($command -eq 'storage blob delete') {
        $name = Get-TestArgument $arguments '--name'
        Assert-Test ($state.RootWorkerUploaded) 'Root files were removed before the retirement worker was uploaded.'
        Assert-Test (-not $name.Contains('/') -and $name -ne 'sw.js') 'Deletion targeted a subdirectory or the retirement worker.'
        Assert-Test ((Get-TestArgument $arguments '--if-match') -eq 'fixture-etag') 'Delete must protect against concurrent updates.'
        if ($state.FailRootDelete) {
            $global:LASTEXITCODE = 1
            return 'Simulated root delete failure.'
        }
        $state.RootDeleted.Add($name)
        return
    }
    throw 'Unexpected mocked Azure command.'
}

function npm {
    $state = $global:JigsawDeploymentMock
    Assert-Test (($args -join ' ') -eq 'run build') 'Unexpected npm command.'
    $state.BuildCalls++
    $global:LASTEXITCODE = if ($state.FailBuild) { 1 } else { 0 }
}

function node {
    $state = $global:JigsawDeploymentMock
    Assert-Test ([string] $args[0] -like '*check-private-data.mjs') 'Unexpected Node command.'
    Assert-Test ($args -contains '--credentials' -and $args -contains '--source') 'Private-data scan arguments were incomplete.'
    Assert-Test (-not (($args -join ' ').Contains($state.Key))) 'Private values appeared in scanner arguments.'
    $state.PrivacyChecks++
    $global:LASTEXITCODE = if ($state.FailPrivacy) { 1 } else { 0 }
}

function Invoke-WebRequest {
    param(
        [uri] $Uri, [string] $Method, [switch] $UseBasicParsing,
        [int] $MaximumRedirection, [int] $TimeoutSec, [string] $ErrorAction,
        [switch] $Verbose, [switch] $Debug
    )
    $state = $global:JigsawDeploymentMock
    $state.WebCalls.Add($Uri.AbsoluteUri)
    Assert-Test ($Method -eq 'Head' -and $Uri.Scheme -eq 'https') 'Website verification must be HTTPS HEAD.'
    Assert-Test (-not $Verbose.IsPresent -and -not $Debug.IsPresent) 'HTTP diagnostics could expose a real URL.'
    if ($state.FailWebsite) { throw [System.Net.WebException]::new('Simulated website connection failure.') }
    $name = $Uri.AbsolutePath.TrimStart('/')
    if ($state.RootWorkerUploaded -and (-not $name -or $state.RootDeleted.Contains($name) -or $state.RootMissing)) {
        return [pscustomobject]@{ StatusCode = $(if ($state.RootStillPublic) { 200 } else { 404 }); Headers = @{} }
    }
    $upload = @($state.Calls | Where-Object {
        $_[0] -eq 'storage' -and $_[1] -eq 'blob' -and $_[2] -eq 'upload' -and
        (Get-TestArgument $_ '--name') -eq $name
    })[-1]
    return [pscustomobject]@{
        StatusCode = 200
        Headers = @{
            'Content-Type' = [string[]] @((Get-TestArgument $upload '--content-type'))
            'Content-Length' = [string[]] @($(if ($state.InvalidWebsiteLength) { 'invalid' } else {
                [string] (Get-Item -LiteralPath (Get-TestArgument $upload '--file')).Length
            }))
        }
    }
}

function Reset-Mocks {
    $script:calls.Clear()
    $script:webCalls.Clear()
    $script:mock.FailUpload = ''
    $script:mock.ErrorContext = ''
    $script:mock.WrongMetadata = ''
    $script:mock.MalformedJson = $false
    $script:mock.FailWebsite = $false
    $script:mock.InvalidWebsiteLength = $false
    $script:mock.FailBuild = $false
    $script:mock.BuildCalls = 0
    $script:mock.PrivacyChecks = 0
    $script:mock.FailPrivacy = $false
    $script:mock.RootDeleted.Clear()
    $script:mock.RootWorkerUploaded = $false
    $script:mock.RootMissing = $false
    $script:mock.FailRootDelete = $false
    $script:mock.RootStillPublic = $false
    $script:mock.DefaultIndexFallback = $false
}

function Write-Credentials {
    param(
        [string] $Text = "Storage account name: testjigsaw123`nConnection string: `"$script:connection`"",
        [string] $Site = 'https://testjigsaw123.z1.web.core.windows.net/',
        [switch] $OmitWebsiteUrl
    )
    if (-not $OmitWebsiteUrl -and $Text -notmatch '(?mi)^\s*[''"]?Website[ _-]*URL[''"]?\s*:') {
        $Text += "`nWebsite URL: `"$Site`""
    }
    [System.IO.File]::WriteAllText($credentialFile, $Text)
}

function Expect-Failure {
    param([scriptblock] $Action, [string] $Expected, [string[]] $PrivateValues = @())
    $failed = $false
    try { & $Action | Out-Null }
    catch {
        $failed = $true
        $message = $_.Exception.Message
        Assert-Test ($message -like "*$Expected*") "Failure did not contain expected explanation: $Expected"
        Assert-Test (-not $message.Contains($script:key)) 'Failure message exposed a key.'
        Assert-Test (-not $message.Contains($script:connection)) 'Failure message exposed a connection string.'
        foreach ($value in $PrivateValues) {
            Assert-Test ($message -notmatch [regex]::Escape($value)) 'Failure message exposed a private infrastructure identifier.'
        }
    }
    Assert-Test $failed 'Operation should have failed.'
}

function Run-Test {
    param([string] $Name, [scriptblock] $Action)
    Reset-Mocks
    Write-Credentials
    & $Action
    $script:testCount++
    Write-Host "PASS: $Name"
}

$environmentNames = @(
    'AZURE_STORAGE_CONNECTION_STRING', 'AZURE_STORAGE_ACCOUNT', 'AZURE_STORAGE_KEY',
    'AZURE_STORAGE_SAS_TOKEN', 'AZURE_STORAGE_SERVICE_ENDPOINT', 'AZURE_CORE_COLLECT_TELEMETRY'
)
$originalEnvironment = @{}
$sentinels = @{}
try {
    New-Item -ItemType Directory -Path $source -Force | Out-Null
    $assetNames = @(
        'opencv.js', 'worker.js', 'app.js', 'app.css', 'manifest.webmanifest', 'icon.svg',
        'apple-touch-icon.png', 'icon-192.png', 'icon-512.png', 'LICENSE-opencv-js.txt',
        'THIRD-PARTY-NOTICES.txt', 'index.html', 'sw.js'
    )
    foreach ($name in $assetNames) { [System.IO.File]::WriteAllText((Join-Path $source $name), "fixture:$name") }
    [System.IO.File]::WriteAllText((Join-Path $source 'access-key.yaml'), 'NEVER UPLOAD THIS FILE')
    foreach ($name in $environmentNames) {
        $originalEnvironment[$name] = [Environment]::GetEnvironmentVariable($name, 'Process')
        $sentinels[$name] = 'prior-test-value-' + $name
        [Environment]::SetEnvironmentVariable($name, $sentinels[$name], 'Process')
    }
    $common = @{ CredentialPath = $credentialFile; SourcePath = $source; Prefix = ''; Confirm = $false }

    Run-Test 'WhatIf checks inputs but performs no build, CLI call, or HTTP request' {
        & $deploymentScript @common -WhatIf -Build | Out-Null
        Assert-Test ($script:calls.Count -eq 0 -and $script:webCalls.Count -eq 0 -and $script:mock.BuildCalls -eq 0) 'WhatIf caused side effects.'
    }
    Run-Test 'The deploy.ps1 entry forwards WhatIf and Build without causing side effects' {
        & $deploymentEntry @common -WhatIf -Build | Out-Null
        Assert-Test ($script:calls.Count -eq 0 -and $script:webCalls.Count -eq 0 -and $script:mock.BuildCalls -eq 0) 'The deployment entry lost WhatIf.'
    }
    Run-Test 'The deploy.ps1 entry forwards explicit root and build options' {
        $result = & $deploymentEntry @common -Build
        Assert-Test ($result.Prefix -eq '' -and $result.FilesUploaded -eq 13 -and $result.WebsiteVerified) 'The entry changed explicit deployment parameters.'
        Assert-Test ($script:mock.BuildCalls -eq 1) 'The entry did not forward Build exactly once.'
    }
    Run-Test 'The deploy.ps1 entry preserves the subdirectory default and root retirement' {
        $parameters = $common.Clone()
        $parameters.Remove('Prefix')
        $result = & $deploymentEntry @parameters -RetireRoot
        Assert-Test ($result.Prefix -eq 'jigsaw-helper' -and $result.RootRetired -and $result.RootFilesRemoved -eq 12) 'The entry did not preserve retirement options or defaults.'
    }
    Run-Test 'The deploy.ps1 entry propagates deployment failures' {
        $script:mock.FailUpload = 'worker.js'
        Expect-Failure { & $deploymentEntry @common } 'Azure CLI failed'
        Assert-Test (-not @($script:calls | Where-Object { (Get-TestArgument $_ '--name') -eq 'sw.js' }).Count) 'The entry continued after a failure.'
    }
    Run-Test 'The local Website URL is used automatically through the deploy.ps1 entry' {
        $parameters = $common.Clone()
        $parameters.Remove('Prefix')
        $site = 'https://testjigsaw123.z1.web.core.windows.net/jigsaw-helper/'
        Write-Credentials "Storage account name: testjigsaw123`nConnection string: `"$script:connection`"`nWebsite URL: `"$site`""
        $result = & $deploymentEntry @parameters
        Assert-Test ($result.WebsiteVerified -and -not $result.PSObject.Properties['WebsiteUrl']) 'Private URL was exposed in deployment output.'
        Assert-Test ($script:webCalls.Count -eq 13) 'The configured public site was not verified.'
        Assert-Test (@($script:webCalls | Where-Object { -not $_.StartsWith($site) }).Count -eq 0) 'Website checks did not use the private configured URL.'
    }
    Run-Test 'Website URL aliases and a Primary endpoint are normalized for the chosen prefix' {
        $parameters = $common.Clone()
        $parameters.Prefix = 'tools/jigsaw-helper'
        Write-Credentials "AccountName: testjigsaw123`nConnectionString: $script:connection`nWebsite_URL: 'https://testjigsaw123.z1.web.core.windows.net/' # placeholder test endpoint"
        $result = & $deploymentScript @parameters
        Assert-Test ($script:webCalls[0] -eq 'https://testjigsaw123.z1.web.core.windows.net/tools/jigsaw-helper/opencv.js') 'Configured URL alias or prefix normalization failed.'
        Assert-Test ($result.WebsiteVerified) 'Configured Primary endpoint was not verified.'
    }
    Run-Test 'Infrastructure URL overrides are not accepted on either command entrypoint' {
        foreach ($scriptPath in @($deploymentEntry, $deploymentScript)) {
            $command = Get-Command $scriptPath
            Assert-Test (-not $command.Parameters.ContainsKey('WebsiteUrl')) 'A private URL override is still exposed.'
        }
    }
    Run-Test 'A configured URL is sufficient for explicit root retirement' {
        $parameters = $common.Clone()
        $parameters.Remove('Prefix')
        Write-Credentials "Storage account name: testjigsaw123`nConnection string: $script:connection`nWebsite URL: https://testjigsaw123.z1.web.core.windows.net/jigsaw-helper/"
        $result = & $deploymentEntry @parameters -RetireRoot
        Assert-Test ($result.RootRetired -and $result.RootFilesRemoved -eq 12 -and $result.WebsiteVerified) 'Root retirement did not accept the private configured URL.'
    }
    Run-Test 'Configured Website URL is validated even during WhatIf without displaying its value' {
        $parameters = $common.Clone()
        $parameters.Remove('Prefix')
        foreach ($site in @(
            'not-an-absolute-URL',
            'http://private.example.test/jigsaw-helper/',
            'https://user:password@private.example.test/jigsaw-helper/',
            'https://private.example.test/jigsaw-helper/?sig=anything',
            'https://private.example.test/jigsaw-helper/#section',
            'https://private.example.test/other/'
        )) {
            Write-Credentials "Storage account name: testjigsaw123`nConnection string: $script:connection`nWebsite URL: `"$site`""
            Expect-Failure { & $deploymentEntry @parameters -WhatIf } 'Website' @($site)
        }
        Assert-Test ($script:calls.Count -eq 0 -and $script:webCalls.Count -eq 0) 'An invalid private URL caused network activity.'
    }
    Run-Test 'Duplicate Website URL aliases are rejected locally' {
        Write-Credentials "Storage account name: testjigsaw123`nConnection string: $script:connection`nWebsite URL: https://first.example.test/`nWebsiteUrl: https://second.example.test/"
        Expect-Failure { & $deploymentEntry @common } 'Duplicate credential'
        Assert-Test ($script:calls.Count -eq 0) 'Duplicate private URLs reached Azure.'
    }
    Run-Test 'A configured URL in WhatIf performs no CLI calls or website requests' {
        $parameters = $common.Clone()
        $parameters.Remove('Prefix')
        Write-Credentials "Storage account name: testjigsaw123`nConnection string: $script:connection`nWebsite URL: https://private.example.test/jigsaw-helper/"
        & $deploymentEntry @parameters -WhatIf | Out-Null
        Assert-Test ($script:calls.Count -eq 0 -and $script:webCalls.Count -eq 0) 'Private-config preview caused network activity.'
    }
    Run-Test 'CLI failures redact the real configured account name and final URL as well as keys' {
        $parameters = $common.Clone()
        $parameters.Remove('Prefix')
        $site = 'https://private.example.test/jigsaw-helper/'
        Write-Credentials "Storage account name: testjigsaw123`nConnection string: $script:connection`nWebsite URL: $site"
        $script:mock.FailUpload = 'jigsaw-helper/worker.js'
        $script:mock.ErrorContext = 'Account TESTJIGSAW123 and URL ' + $site.ToUpperInvariant() +
            ' host PRIVATE.EXAMPLE.TEST and encoded key ' + [uri]::EscapeDataString($script:key)
        Expect-Failure { & $deploymentEntry @parameters } 'Azure CLI failed' @('testjigsaw123', $site, 'private.example.test', [uri]::EscapeDataString($script:key))
    }
    Run-Test 'Exact allowlist, MIME, verification, upload order and environment restoration' {
        $result = & $deploymentScript @common
        Assert-Test ($result.FilesUploaded -eq 13 -and $result.BlobMetadataVerified -and $result.WebsiteVerified) 'Incorrect deployment result.'
        $uploads = @($script:calls | Where-Object { $_[0..2] -join ' ' -eq 'storage blob upload' })
        Assert-Test ($uploads.Count -eq 13) 'Unexpected upload count.'
        Assert-Test ((Get-TestArgument $uploads[-1] '--name') -eq 'sw.js') 'Service Worker was not last.'
        Assert-Test ((Get-TestArgument $uploads[-2] '--name') -eq 'index.html') 'Index must precede Service Worker.'
        $mime = @{}
        foreach ($upload in $uploads) { $mime[(Get-TestArgument $upload '--name')] = Get-TestArgument $upload '--content-type' }
        Assert-Test ($mime['opencv.js'] -eq 'application/javascript') 'OpenCV MIME incorrect.'
        Assert-Test ($mime['sw.js'] -eq 'application/javascript') 'Service Worker MIME incorrect.'
        Assert-Test ($mime['manifest.webmanifest'] -eq 'application/manifest+json') 'Manifest MIME incorrect.'
        Assert-Test (-not $mime.ContainsKey('access-key.yaml')) 'Credentials were uploaded.'
        Assert-Test (@($script:calls | Where-Object { $_[0..2] -join ' ' -eq 'storage blob show' }).Count -eq 13) 'Not all uploads were verified.'
        foreach ($name in $environmentNames) {
            Assert-Test ([Environment]::GetEnvironmentVariable($name, 'Process') -ceq $sentinels[$name]) 'Environment was not restored.'
        }
    }
    Run-Test 'Configured public URL is verified for every asset without passing auth arguments' {
        $result = & $deploymentScript @common
        Assert-Test ($result.WebsiteVerified -and $script:webCalls.Count -eq 13) 'Public website was not verified.'
    }
    Run-Test 'Default deployment uses jigsaw-helper and never writes root blobs' {
        $parameters = $common.Clone()
        $parameters.Remove('Prefix')
        $result = & $deploymentScript @parameters
        Assert-Test ($result.Prefix -eq 'jigsaw-helper') 'Default prefix was not applied.'
        Assert-Test ($script:webCalls[0] -eq 'https://testjigsaw123.z1.web.core.windows.net/jigsaw-helper/opencv.js') 'Prefix was not added to the configured endpoint.'
        $uploads = @($script:calls | Where-Object { $_[0..2] -join ' ' -eq 'storage blob upload' })
        $checks = @($script:calls | Where-Object { $_[0..2] -join ' ' -eq 'storage blob show' })
        Assert-Test ($uploads.Count -eq 13 -and $checks.Count -eq 13) 'Prefixed upload verification was incomplete.'
        foreach ($call in @($uploads) + @($checks)) {
            Assert-Test ((Get-TestArgument $call '--name').StartsWith('jigsaw-helper/')) 'A root blob was accessed during prefixed deployment.'
        }
        Assert-Test ((Get-TestArgument $uploads[-1] '--name') -eq 'jigsaw-helper/sw.js') 'Prefixed Service Worker was not last.'
        Assert-Test (-not @($script:calls | Where-Object { $_ -contains 'delete' }).Count) 'Existing files were deleted.'
        Assert-Test (@($script:webCalls | Where-Object { $_ -notlike 'https://testjigsaw123.z1.web.core.windows.net/jigsaw-helper/*' }).Count -eq 0) 'Website checks escaped the prefix.'
    }
    Run-Test 'Nested prefixes and an already-prefixed public URL are normalized once' {
        $parameters = $common.Clone()
        $parameters.Prefix = '/tools/jigsaw-helper/'
        Write-Credentials -Site 'https://testjigsaw123.z1.web.core.windows.net/tools/jigsaw-helper'
        $result = & $deploymentScript @parameters
        Assert-Test ($result.Prefix -eq 'tools/jigsaw-helper') 'Nested prefix was not normalized.'
        Assert-Test ($script:webCalls[0] -eq 'https://testjigsaw123.z1.web.core.windows.net/tools/jigsaw-helper/opencv.js') 'Prefix was duplicated or directory slash was lost.'
        Assert-Test ($script:webCalls.Count -eq 13) 'Nested public website checks were incomplete.'
    }
    Run-Test 'Unsafe prefixes fail locally without accessing Azure' {
        foreach ($prefix in @('../other', 'folder/../other', 'folder//other', 'folder\other', 'folder?sig=anything', 'folder%2fother', ' ')) {
            $parameters = $common.Clone()
            $parameters.Prefix = $prefix
            Expect-Failure { & $deploymentScript @parameters } '-Prefix must contain'
        }
        Assert-Test ($script:calls.Count -eq 0) 'An unsafe prefix reached Azure.'
    }
    Run-Test 'Public URL path must match the prefix before any Azure changes' {
        $parameters = $common.Clone()
        $parameters.Prefix = 'jigsaw-helper'
        Write-Credentials -Site 'https://testjigsaw123.z1.web.core.windows.net/other/'
        Expect-Failure { & $deploymentScript @parameters } 'directory matching -Prefix'
        Assert-Test ($script:calls.Count -eq 0) 'Azure changed before a mismatched URL was rejected.'
    }
    Run-Test 'Root retirement deletes only the named root app files after verifying the subdirectory' {
        $parameters = $common.Clone()
        $parameters.Prefix = 'jigsaw-helper'
        $result = & $deploymentScript @parameters -RetireRoot
        Assert-Test ($result.RootRetired -and $result.RootFilesRemoved -eq 12 -and $result.FilesUploaded -eq 14) 'Root retirement result was incorrect.'
        $expected = @($assetNames | Where-Object { $_ -ne 'sw.js' } | Sort-Object)
        Assert-Test (($script:mock.RootDeleted | Sort-Object) -join ',' -eq ($expected -join ',')) 'Deletion escaped the root application allowlist.'
        Assert-Test ($script:mock.RootDeleted[0] -eq 'index.html') 'Root homepage should be removed first.'
        Assert-Test ($script:webCalls.Count -eq 26) 'Both subdirectory assets and all retired root paths must be checked.'
        Assert-Test ($script:webCalls[0].Contains('/jigsaw-helper/')) 'Subdirectory was not checked first.'
        foreach ($name in $environmentNames) {
            Assert-Test ([Environment]::GetEnvironmentVariable($name, 'Process') -ceq $sentinels[$name]) 'Environment leaked during root retirement.'
        }
    }
    Run-Test 'Root retirement preview performs no uploads or deletions' {
        $parameters = $common.Clone()
        $parameters.Prefix = 'jigsaw-helper'
        & $deploymentScript @parameters -RetireRoot -WhatIf | Out-Null
        Assert-Test ($script:calls.Count -eq 0 -and $script:webCalls.Count -eq 0) 'Root retirement preview changed Azure.'
    }
    Run-Test 'Root retirement rejects root deployments or missing public verification URLs' {
        Expect-Failure { & $deploymentScript @common -RetireRoot } 'nonempty -Prefix'
        $parameters = $common.Clone()
        $parameters.Prefix = 'jigsaw-helper'
        Write-Credentials -OmitWebsiteUrl
        Expect-Failure { & $deploymentScript @parameters -RetireRoot } 'Website URL'
        Assert-Test ($script:calls.Count -eq 0) 'Unsafe retirement changed Azure.'
    }
    Run-Test 'Root retirement is repeatable when the old root files are already missing' {
        $parameters = $common.Clone()
        $parameters.Prefix = 'jigsaw-helper'
        $script:mock.RootMissing = $true
        $result = & $deploymentScript @parameters -RetireRoot
        Assert-Test ($result.RootRetired -and $result.RootFilesRemoved -eq 0) 'Already-missing root files caused an incorrect result.'
        Assert-Test ($script:mock.RootDeleted.Count -eq 0) 'Missing files were deleted.'
    }
    Run-Test 'Root deletion failures stop retirement rather than reporting success' {
        $parameters = $common.Clone()
        $parameters.Prefix = 'jigsaw-helper'
        $script:mock.FailRootDelete = $true
        Expect-Failure { & $deploymentScript @parameters -RetireRoot } 'Azure CLI failed'
        Assert-Test ($script:mock.RootDeleted.Count -eq 0) 'Retirement continued after a delete failure.'
    }
    Run-Test 'A still-public root fails the required HTTP 404 verification' {
        $parameters = $common.Clone()
        $parameters.Prefix = 'jigsaw-helper'
        $script:mock.RootStillPublic = $true
        Expect-Failure { & $deploymentScript @parameters -RetireRoot } 'Expected HTTP 404'
    }
    Run-Test 'An account-wide index fallback is not silently changed for root retirement' {
        $parameters = $common.Clone()
        $parameters.Prefix = 'jigsaw-helper'
        $script:mock.DefaultIndexFallback = $true
        Expect-Failure { & $deploymentScript @parameters -RetireRoot } 'default index-document fallback'
        Assert-Test ($script:calls.Count -eq 1) 'Unrelated static settings were modified.'
    }
    Run-Test 'Build runs exactly once before Azure operations' {
        $result = & $deploymentScript @common -Build
        Assert-Test ($script:mock.BuildCalls -eq 1 -and $result.FilesUploaded -eq 13) 'Build was not executed.'
    }
    Run-Test 'A failed build performs no Azure operations' {
        $script:mock.FailBuild = $true
        Expect-Failure { & $deploymentScript @common -Build } 'Static build failed'
        Assert-Test ($script:calls.Count -eq 0) 'Azure changed after build failure.'
    }
    Run-Test 'CLI failure is redacted, stops uploads, and restores environment' {
        $script:mock.FailUpload = 'worker.js'
        Expect-Failure { & $deploymentScript @common } 'Azure CLI failed'
        Assert-Test (-not @($script:calls | Where-Object { (Get-TestArgument $_ '--name') -eq 'sw.js' }).Count) 'SW was published after a failure.'
        foreach ($name in $environmentNames) {
            Assert-Test ([Environment]::GetEnvironmentVariable($name, 'Process') -ceq $sentinels[$name]) 'Environment leaked after a failure.'
        }
    }
    Run-Test 'Wrong uploaded metadata fails instead of reporting success' {
        $script:mock.WrongMetadata = 'app.js'
        Expect-Failure { & $deploymentScript @common } 'metadata verification failed'
    }
    Run-Test 'Malformed CLI output is not printed, even if it includes a key' {
        $script:mock.MalformedJson = $true
        Expect-Failure { & $deploymentScript @common } 'invalid JSON'
    }
    Run-Test 'Public endpoint failures are not reported as successful deployment' {
        $script:mock.FailWebsite = $true
        Expect-Failure { & $deploymentScript @common } 'Public website check failed'
    }
    Run-Test 'Malformed public Content-Length fails verification instead of casting or defaulting' {
        $script:mock.InvalidWebsiteLength = $true
        Expect-Failure { & $deploymentScript @common } 'Public website content verification failed'
    }
    Run-Test 'Account mismatches fail before Azure is contacted' {
        Write-Credentials "Storage account name: anotheraccount`nConnection string: $script:connection"
        Expect-Failure { & $deploymentScript @common } 'does not match'
        Assert-Test ($script:calls.Count -eq 0) 'Azure was contacted with mismatched accounts.'
    }
    Run-Test 'Duplicate YAML fields fail without showing their values' {
        Write-Credentials "Storage account name: testjigsaw123`nAccountName: duplicate`nConnection string: $script:connection"
        Expect-Failure { & $deploymentScript @common } 'Duplicate credential'
    }
    Run-Test 'Quoted aliases, comments and unquoted connection strings are supported' {
        Write-Credentials "# fixture comment`n'AccountName': 'testjigsaw123' # account label`nConnectionString: $script:connection # connection comment"
        & $deploymentScript @common -WhatIf | Out-Null
    }
    Run-Test 'Invalid and non-Azure connection strings are rejected safely' {
        foreach ($text in @(
            $script:connection.Replace('https', 'http'),
            $script:connection.Replace('core.windows.net', 'attacker.invalid'),
            ($script:connection + ';BlobEndpoint=https://attacker.invalid/'),
            $script:connection.Replace($script:key, 'not-base64')
        )) {
            Write-Credentials "Storage account name: testjigsaw123`nConnection string: $text"
            Expect-Failure { & $deploymentScript @common } ''
        }
        Assert-Test ($script:calls.Count -eq 0) 'Rejected credentials reached Azure CLI.'
    }
    Run-Test 'Missing assets fail before changing Azure' {
        $path = Join-Path $source 'sw.js'
        Remove-Item -LiteralPath $path
        try {
            Expect-Failure { & $deploymentScript @common } 'Required static asset missing'
            Assert-Test ($script:calls.Count -eq 0) 'Azure changed with an incomplete build.'
        } finally { [System.IO.File]::WriteAllText($path, 'fixture:sw.js') }
    }
    Run-Test 'Insecure or credential-bearing website URLs fail locally' {
        foreach ($url in @('http://example.test/', 'https://user:password@example.test/', 'https://example.test/?sig=anything')) {
            Write-Credentials -Site $url
            Expect-Failure { & $deploymentScript @common } 'must be HTTPS' @($url)
        }
        Assert-Test ($script:calls.Count -eq 0) 'Invalid website URL reached Azure.'
    }
    Run-Test 'Private-data preflight failures prevent every Azure operation' {
        $script:mock.FailPrivacy = $true
        Expect-Failure { & $deploymentEntry @common } 'Private-data preflight failed'
        Assert-Test ($script:mock.PrivacyChecks -eq 1 -and $script:calls.Count -eq 0) 'Cloud operations ran after a private-data failure.'
    }
    Run-Test 'Success summaries and verbose output contain no infrastructure identifiers' {
        $records = @(& $deploymentEntry @common -Verbose 6>&1 4>&1)
        $text = ($records | ForEach-Object { $_.ToString() }) -join "`n"
        foreach ($value in @('testjigsaw123', $script:connection, $script:key, 'https://testjigsaw123.z1.web.core.windows.net/')) {
            Assert-Test ($text -notmatch [regex]::Escape($value)) 'A success message exposed private configuration.'
        }
        $result = @($records | Where-Object { $_.PSObject.Properties['FilesUploaded'] })[0]
        Assert-Test (-not $result.PSObject.Properties['WebsiteUrl']) 'The return object exposed the private URL.'
        Assert-Test ($script:mock.PrivacyChecks -eq 1) 'The mandatory privacy check did not run.'
    }
    Write-Host ("All {0} deployment tests passed. No requests were made to Azure." -f $script:testCount)
} finally {
    if ($previousMock) { $global:JigsawDeploymentMock = $previousMock.Value }
    else { Remove-Variable -Name JigsawDeploymentMock -Scope Global -ErrorAction SilentlyContinue }
    foreach ($name in $originalEnvironment.Keys) {
        [Environment]::SetEnvironmentVariable($name, $originalEnvironment[$name], 'Process')
    }
    if (Test-Path -LiteralPath $source -PathType Container) {
        foreach ($file in Get-ChildItem -LiteralPath $source -File) { Remove-Item -LiteralPath $file.FullName }
        Remove-Item -LiteralPath $source
    }
    if (Test-Path -LiteralPath $credentialFile -PathType Leaf) { Remove-Item -LiteralPath $credentialFile }
    if (Test-Path -LiteralPath $fixtureRoot -PathType Container) { Remove-Item -LiteralPath $fixtureRoot }
}
