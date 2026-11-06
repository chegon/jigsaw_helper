#Requires -Version 5.1
<#
.SYNOPSIS
Build and deploy Jigsaw Helper to Azure Storage static website hosting.
.DESCRIPTION
Forwards the deployment options to deploy-azure.ps1. Reads access-key.yaml
locally by default; credentials are never included in the static build.
.EXAMPLE
.\deploy.ps1 -WhatIf
.EXAMPLE
.\deploy.ps1 -Build -WebsiteUrl 'https://ACCOUNT.zXX.web.core.windows.net/'
.EXAMPLE
.\deploy.ps1 -Prefix 'tools/jigsaw-helper' -Build
.EXAMPLE
.\deploy.ps1 -RetireRoot -WebsiteUrl 'https://ACCOUNT.zXX.web.core.windows.net/'
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

& (Join-Path $PSScriptRoot 'deploy-azure.ps1') @PSBoundParameters
