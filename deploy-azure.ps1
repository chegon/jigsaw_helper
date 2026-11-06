#Requires -Version 5.1
<#
.SYNOPSIS
Deploy the static iPhone application to an existing Azure Storage account.
.EXAMPLE
.\deploy-azure.ps1 -WhatIf
.EXAMPLE
.\deploy-azure.ps1 -Build
.EXAMPLE
.\deploy-azure.ps1 -WebsiteUrl 'https://ACCOUNT.zXX.web.core.windows.net/'
.EXAMPLE
.\deploy-azure.ps1 -Prefix 'tools/jigsaw-helper' -Build
.EXAMPLE
.\deploy-azure.ps1 -Prefix '' -Build
.EXAMPLE
.\deploy-azure.ps1 -RetireRoot -WebsiteUrl 'https://ACCOUNT.zXX.web.core.windows.net/'
#>
[CmdletBinding(SupportsShouldProcess = $true, ConfirmImpact = 'Medium')]
param(
    [string] $CredentialPath = (Join-Path $PSScriptRoot 'access-key.yaml'),
    [string] $SourcePath = (Join-Path $PSScriptRoot 'web\dist'),
    [AllowEmptyString()]
    [string] $Prefix = 'jigsaw-helper',
    [switch] $Build,
    [switch] $RetireRoot,
    [uri] $WebsiteUrl
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Read-DeploymentCredentials {
    param([string] $Path)

    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
        throw 'Credential file not found. Supply -CredentialPath or create access-key.yaml.'
    }
    $values = @{}
    $lineNumber = 0
    foreach ($line in [System.IO.File]::ReadAllLines((Resolve-Path -LiteralPath $Path).Path)) {
        $lineNumber++
        if ($line -match '^\s*(#.*)?$') { continue }
        if ($line -notmatch '^\s*(?<label>[^:]+):\s*(?<value>.*)$') {
            throw "Invalid credential file syntax on line $lineNumber. Use flat YAML key: value entries."
        }
        $label = $Matches['label'].Trim().Trim([char]34, [char]39) -replace '[ _-]', ''
        $value = $Matches['value'].Trim()
        if ($value.StartsWith('"') -or $value.StartsWith("'")) {
            $quote = $value.Substring(0, 1)
            $pattern = '^' + [regex]::Escape($quote) + '(?<text>.*)' + [regex]::Escape($quote) + '\s*(?:#.*)?$'
            if ($value -notmatch $pattern) { throw "Unclosed quoted value on line $lineNumber." }
            $value = $Matches['text']
            if ($quote -eq "'") { $value = $value.Replace("''", "'") }
        } else {
            $value = ($value -replace '\s+#.*$', '').Trim()
        }
        switch ($label.ToLowerInvariant()) {
            'storageaccountname' { $field = 'AccountName' }
            'accountname' { $field = 'AccountName' }
            'connectionstring' { $field = 'ConnectionString' }
            default { throw "Unsupported credential field on line $lineNumber. Expected Storage account name or Connection string." }
        }
        if ($values.ContainsKey($field)) { throw "Duplicate credential field on line $lineNumber." }
        $values[$field] = $value
    }
    if (-not $values.ContainsKey('AccountName') -or $values['AccountName'] -cnotmatch '^[a-z0-9]{3,24}$') {
        throw 'The credential file needs a valid Storage account name.'
    }
    if (-not $values.ContainsKey('ConnectionString')) {
        throw 'The credential file needs a Connection string containing AccountName and AccountKey.'
    }
    $parts = @{}
    foreach ($entry in $values['ConnectionString'].Split(';')) {
        if (-not $entry.Trim()) { continue }
        $pair = $entry.Split([char[]] @('='), 2)
        if ($pair.Count -ne 2 -or $parts.ContainsKey($pair[0].Trim())) {
            throw 'Invalid or duplicate connection-string fields.'
        }
        $parts[$pair[0].Trim()] = $pair[1].Trim()
    }
    if (-not $parts.ContainsKey('AccountName') -or $parts['AccountName'] -cne $values['AccountName']) {
        throw 'Storage account name does not match AccountName in the connection string.'
    }
    if (-not $parts.ContainsKey('AccountKey') -or -not $parts['AccountKey']) {
        throw 'The connection string must contain an AccountKey, not a SAS token.'
    }
    try { $decoded = [Convert]::FromBase64String($parts['AccountKey']) }
    catch [FormatException] { throw 'AccountKey is not valid Base64. Its value has not been displayed.' }
    $keyLength = $decoded.Length
    [Array]::Clear($decoded, 0, $decoded.Length)
    if ($keyLength -ne 64) { throw 'AccountKey must decode to a 64-byte Azure Storage account key.' }
    if (-not $parts.ContainsKey('DefaultEndpointsProtocol') -or $parts['DefaultEndpointsProtocol'] -ne 'https') {
        throw 'The connection string must use DefaultEndpointsProtocol=https.'
    }
    $suffixes = @('core.windows.net', 'core.usgovcloudapi.net', 'core.chinacloudapi.cn')
    if (-not $parts.ContainsKey('EndpointSuffix') -or $parts['EndpointSuffix'] -notin $suffixes) {
        throw 'Use an Azure Storage connection string with a supported EndpointSuffix.'
    }
    foreach ($field in $parts.Keys) {
        if ($field -notin @('AccountName', 'AccountKey', 'DefaultEndpointsProtocol', 'EndpointSuffix')) {
            throw 'Use a standard Azure connection string without custom endpoints, proxy destinations, or SAS fields.'
        }
    }
    return [pscustomobject]@{
        AccountName = $values['AccountName']
        AccountKey = $parts['AccountKey']
        ConnectionString = $values['ConnectionString']
    }
}

function Protect-DeploymentMessage {
    param([string] $Text)

    $safe = $Text.Replace($script:credentials.ConnectionString, '[REDACTED]')
    $safe = $safe.Replace($script:credentials.AccountKey, '[REDACTED]')
    return ($safe -replace '(?i)(AccountKey|SharedAccessSignature|sig)\s*=\s*[^;\s"'']+', '$1=[REDACTED]')
}

function Invoke-DeploymentAz {
    param([string[]] $Arguments, [string] $Operation, [switch] $Json)

    # Capture stderr before checking the exit code; Windows PowerShell wraps it in ErrorRecord.
    $ErrorActionPreference = 'Continue'
    $PSNativeCommandUseErrorActionPreference = $false
    $format = if ($Json) { 'json' } else { 'none' }
    $output = & $script:azCommand @Arguments --only-show-errors --output $format 2>&1
    $exitCode = $LASTEXITCODE
    $text = ($output | ForEach-Object { $_.ToString() }) -join "`n"
    if ($exitCode -ne 0) {
        $safe = Protect-DeploymentMessage $text
        throw "Azure CLI failed while $Operation (exit $exitCode). $safe"
    }
    if ($Json) {
        try { return (ConvertFrom-Json -InputObject $text -ErrorAction Stop) }
        catch { throw "Azure CLI returned invalid JSON while $Operation. Raw output has been withheld." }
    }
}

function Send-DeploymentAsset {
    param([string] $BlobName, [string] $Path, [string] $MimeType, [string[]] $AccountArguments)

    $uploadArgs = @(
        'storage', 'blob', 'upload', '--container-name', '$web', '--name', $BlobName,
        '--file', $Path, '--overwrite', 'true', '--type', 'block',
        '--content-type', $MimeType, '--content-cache-control', 'no-cache',
        '--validate-content', '--no-progress'
    ) + $AccountArguments
    Invoke-DeploymentAz -Arguments $uploadArgs -Operation "uploading $BlobName"
    $verifyArgs = @(
        'storage', 'blob', 'show', '--container-name', '$web', '--name', $BlobName,
        '--query', '{length:properties.contentLength,type:properties.contentSettings.contentType,cache:properties.contentSettings.cacheControl}'
    ) + $AccountArguments
    $properties = Invoke-DeploymentAz -Arguments $verifyArgs -Operation "verifying $BlobName" -Json
    if (-not $properties -or
        -not $properties.PSObject.Properties['length'] -or
        -not $properties.PSObject.Properties['type'] -or
        -not $properties.PSObject.Properties['cache'] -or
        $properties.length -ne (Get-Item -LiteralPath $Path).Length -or
        $properties.type -ne $MimeType -or $properties.cache -ne 'no-cache') {
        throw "Uploaded metadata verification failed for $BlobName. Deployment stopped; do not assume the website is ready."
    }
}

$blobPrefix = $Prefix.Trim('/')
if ($blobPrefix -and $blobPrefix -cnotmatch '^[A-Za-z0-9][A-Za-z0-9_-]*(/[A-Za-z0-9][A-Za-z0-9_-]*)*$') {
    throw '-Prefix must contain directory names separated by /, using letters, digits, hyphens, or underscores. Use an empty string for the website root.'
}
if ($RetireRoot -and (-not $blobPrefix -or -not $WebsiteUrl)) {
    throw '-RetireRoot requires a nonempty -Prefix and -WebsiteUrl so the subdirectory can be verified before root files are removed.'
}
$retirementWorker = Join-Path $PSScriptRoot 'web\retire-root-sw.js'
if ($RetireRoot -and (-not (Test-Path -LiteralPath $retirementWorker -PathType Leaf) -or
    ((Get-Item -LiteralPath $retirementWorker).Attributes -band [System.IO.FileAttributes]::ReparsePoint))) {
    throw 'The root retirement worker is missing or is a symbolic link.'
}
$deploymentUrl = $null
if ($WebsiteUrl) {
    if (-not $WebsiteUrl.IsAbsoluteUri -or $WebsiteUrl.Scheme -ne 'https' -or
        $WebsiteUrl.UserInfo -or $WebsiteUrl.Query -or $WebsiteUrl.Fragment) {
        throw '-WebsiteUrl must be the HTTPS static website URL, without credentials, query, or fragment.'
    }
    $providedPath = $WebsiteUrl.AbsolutePath.Trim('/')
    if ($providedPath -and $providedPath -cne $blobPrefix) {
        throw '-WebsiteUrl must be the Primary endpoint root or the directory matching -Prefix.'
    }
    $deploymentPath = if ($blobPrefix) { '/' + $blobPrefix + '/' } else { '/' }
    $deploymentUrl = [uri] ($WebsiteUrl.GetLeftPart([System.UriPartial]::Authority) + $deploymentPath)
}
$script:credentials = Read-DeploymentCredentials -Path $CredentialPath

if ($Build) {
    if ($WhatIfPreference) {
        Write-Host 'What if: build the static application with npm run build (not executed).'
    } else {
        if (-not (Get-Command npm -ErrorAction SilentlyContinue)) {
            throw 'Node.js / npm is required for -Build. Install it, or omit -Build to publish existing assets.'
        }
        Push-Location $PSScriptRoot
        try {
            & npm run build
            if ($LASTEXITCODE -ne 0) { throw 'Static build failed. No Azure operations were performed.' }
        } finally { Pop-Location }
    }
}

# Deliberate allowlist: never upload a project directory or credential file recursively.
$assets = [ordered]@{
    'opencv.js' = 'application/javascript'
    'worker.js' = 'application/javascript'
    'app.js' = 'application/javascript'
    'app.css' = 'text/css; charset=utf-8'
    'manifest.webmanifest' = 'application/manifest+json'
    'icon.svg' = 'image/svg+xml'
    'apple-touch-icon.png' = 'image/png'
    'icon-192.png' = 'image/png'
    'icon-512.png' = 'image/png'
    'LICENSE-opencv-js.txt' = 'text/plain; charset=utf-8'
    'THIRD-PARTY-NOTICES.txt' = 'text/plain; charset=utf-8'
    'index.html' = 'text/html; charset=utf-8'
    'sw.js' = 'application/javascript'
}
if (-not (Test-Path -LiteralPath $SourcePath -PathType Container)) {
    throw 'Static build folder not found. Run npm run build, or provide -SourcePath.'
}
$sourceDirectory = (Resolve-Path -LiteralPath $SourcePath).Path
if ((Get-Item -LiteralPath $sourceDirectory).Attributes -band [System.IO.FileAttributes]::ReparsePoint) {
    throw 'The static build directory must not be a symbolic link or junction.'
}
foreach ($name in $assets.Keys) {
    $path = Join-Path $sourceDirectory $name
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) {
        throw "Required static asset missing: $name. Run npm run build before deploying."
    }
    if ((Get-Item -LiteralPath $path).Attributes -band [System.IO.FileAttributes]::ReparsePoint) {
        throw "Static asset must not be a symbolic link: $name."
    }
}
Write-Host ('Validated {0} static assets. Extra files, including credentials, will not be uploaded.' -f $assets.Count)
$target = 'the configured Azure Storage account / $web'
if ($blobPrefix) { $target += '/' + $blobPrefix }
$operation = 'Enable static hosting and overwrite the 13 application assets (other blobs are preserved)'
if ($RetireRoot) {
    $operation += '; replace root sw.js with a retirement worker and delete the 12 named old root app files'
}
if (-not $PSCmdlet.ShouldProcess($target, $operation)) {
    $script:credentials = $null
    return
}

$script:azCommand = Get-Command az -ErrorAction SilentlyContinue
if (-not $script:azCommand) {
    throw 'Azure CLI is required. Install it with: winget install --id Microsoft.AzureCLI -e'
}
$environment = @{
    AZURE_STORAGE_CONNECTION_STRING = $script:credentials.ConnectionString
    AZURE_STORAGE_ACCOUNT = $script:credentials.AccountName
    AZURE_STORAGE_KEY = $null
    AZURE_STORAGE_SAS_TOKEN = $null
    AZURE_STORAGE_SERVICE_ENDPOINT = $null
    AZURE_CORE_COLLECT_TELEMETRY = 'no'
}
$previousEnvironment = @{}
try {
    foreach ($name in $environment.Keys) {
        $previousEnvironment[$name] = [Environment]::GetEnvironmentVariable($name, 'Process')
        [Environment]::SetEnvironmentVariable($name, $environment[$name], 'Process')
    }
    $accountArgs = @('--account-name', $script:credentials.AccountName, '--auth-mode', 'key')
    $existing = Invoke-DeploymentAz -Arguments (@('storage', 'blob', 'service-properties', 'show') + $accountArgs) `
        -Operation 'reading static website settings' -Json
    if ($RetireRoot -and $existing.PSObject.Properties['staticWebsite'] -and $existing.staticWebsite -and
        $existing.staticWebsite.PSObject.Properties['defaultIndexDocumentPath'] -and $existing.staticWebsite.defaultIndexDocumentPath) {
        throw 'A default index-document fallback is configured. Remove it explicitly before retiring the root; no unrelated static settings were changed.'
    }
    $updateArgs = @('storage', 'blob', 'service-properties', 'update', '--static-website', 'true', '--index-document', 'index.html')
    if ($existing.PSObject.Properties['staticWebsite'] -and $existing.staticWebsite -and
        $existing.staticWebsite.PSObject.Properties['errorDocument404Path'] -and $existing.staticWebsite.errorDocument404Path) {
        $updateArgs += @('--404-document', $existing.staticWebsite.errorDocument404Path)
    }
    Invoke-DeploymentAz -Arguments ($updateArgs + $accountArgs) -Operation 'enabling static website hosting'
    Invoke-DeploymentAz -Arguments (@('storage', 'container', 'create', '--name', '$web', '--public-access', 'off') + $accountArgs) `
        -Operation 'ensuring the $web container exists'

    $position = 0
    foreach ($name in $assets.Keys) {
        $position++
        $path = Join-Path $sourceDirectory $name
        $blobName = if ($blobPrefix) { $blobPrefix + '/' + $name } else { $name }
        Write-Host ('[{0}/{1}] Uploading {2}' -f $position, $assets.Count, $blobName)
        Send-DeploymentAsset -BlobName $blobName -Path $path -MimeType $assets[$name] -AccountArguments $accountArgs
    }

    $websiteVerified = $false
    if ($deploymentUrl) {
        Write-Host 'Checking the public HTTPS static website without sending credentials...'
        foreach ($name in $assets.Keys) {
            $url = $deploymentUrl.AbsoluteUri + $name
            $response = $null
            for ($attempt = 1; $attempt -le 5; $attempt++) {
                try {
                    $response = Invoke-WebRequest -Uri $url -Method Head -UseBasicParsing `
                        -MaximumRedirection 0 -TimeoutSec 30 -ErrorAction Stop
                    break
                } catch {
                    $status = 0
                    if ($_.Exception.PSObject.Properties['Response'] -and $_.Exception.Response) {
                        $status = [int] $_.Exception.Response.StatusCode
                    }
                    if ($status -eq 404 -and $attempt -lt 5) { Start-Sleep -Seconds 2; continue }
                    throw "Public website check failed for $name (HTTP $status). Check the Primary endpoint and storage network/firewall settings."
                }
            }
            $type = ([string] $response.Headers['Content-Type']).Split(';')[0].Trim()
            $expectedType = $assets[$name].Split(';')[0]
            $contentLength = 0L
            $validLength = [long]::TryParse([string] $response.Headers['Content-Length'], [ref] $contentLength)
            if ($response.StatusCode -ne 200 -or $type -ne $expectedType -or
                -not $validLength -or $contentLength -ne (Get-Item -LiteralPath (Join-Path $sourceDirectory $name)).Length) {
                throw "Public website content verification failed for $name. Check the URL and content headers."
            }
        }
        $websiteVerified = $true
        Write-Host ('Website verified: {0}' -f $deploymentUrl.AbsoluteUri)
    } else {
        Write-Host 'Assets uploaded and verified in Blob Storage. The public website URL was not checked.'
        Write-Host 'Find Primary endpoint in Azure Portal > Storage account > Static website.'
        Write-Host 'Optional: pass -WebsiteUrl https://ACCOUNT.zXX.web.core.windows.net/; -Prefix is appended automatically.'
    }

    $rootFilesRemoved = 0
    if ($RetireRoot) {
        Write-Host 'Retiring the old root app; unrelated blobs and subdirectories will not be deleted.'
        Send-DeploymentAsset -BlobName 'sw.js' -Path $retirementWorker -MimeType 'application/javascript' -AccountArguments $accountArgs
        $rootFiles = @('index.html') + @($assets.Keys | Where-Object { $_ -notin @('index.html', 'sw.js') })
        foreach ($name in $rootFiles) {
            $existsArgs = @('storage', 'blob', 'exists', '--container-name', '$web', '--name', $name, '--query', 'exists') + $accountArgs
            $exists = Invoke-DeploymentAz -Arguments $existsArgs -Operation "checking old root $name" -Json
            if ($exists -isnot [bool]) { throw "Invalid existence response for root $name. Retirement stopped." }
            if (-not $exists) { continue }
            $etagArgs = @('storage', 'blob', 'show', '--container-name', '$web', '--name', $name, '--query', 'properties.etag') + $accountArgs
            $etag = Invoke-DeploymentAz -Arguments $etagArgs -Operation "reading root $name ETag" -Json
            if ($etag -isnot [string] -or -not $etag) { throw "Missing ETag for root $name. Retirement stopped." }
            $deleteArgs = @('storage', 'blob', 'delete', '--container-name', '$web', '--name', $name, '--if-match', $etag) + $accountArgs
            Invoke-DeploymentAz -Arguments $deleteArgs -Operation "removing old root $name"
            $rootFilesRemoved++
        }
        $rootUrl = $deploymentUrl.GetLeftPart([System.UriPartial]::Authority) + '/'
        foreach ($name in @('') + $rootFiles) {
            $status = 0
            try {
                $response = Invoke-WebRequest -Uri ($rootUrl + $name) -Method Head -UseBasicParsing `
                    -MaximumRedirection 0 -TimeoutSec 30 -ErrorAction Stop
                $status = [int] $response.StatusCode
            } catch {
                if ($_.Exception.PSObject.Properties['Response'] -and $_.Exception.Response) {
                    $status = [int] $_.Exception.Response.StatusCode
                } else {
                    throw 'Could not verify the retired root over HTTPS. Check network connectivity.'
                }
            }
            if ($status -ne 404) { throw "Expected HTTP 404 for retired root /$name but received $status." }
        }
        Write-Host 'Root and old root app files return HTTP 404. Root sw.js remains only to retire previously cached root installations.'
    }
    [pscustomobject]@{
        FilesUploaded = $assets.Count + [int] [bool] $RetireRoot
        Prefix = $blobPrefix
        BlobMetadataVerified = $true
        WebsiteVerified = $websiteVerified
        WebsiteUrl = if ($deploymentUrl) { $deploymentUrl.AbsoluteUri } else { $null }
        RootRetired = [bool] $RetireRoot
        RootFilesRemoved = $rootFilesRemoved
    }
} finally {
    foreach ($name in $previousEnvironment.Keys) {
        [Environment]::SetEnvironmentVariable($name, $previousEnvironment[$name], 'Process')
    }
    $script:credentials = $null
}
