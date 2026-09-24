param(
  [switch]$Once,
  [string]$ConfigPath = ""
)

$ErrorActionPreference = "Stop"
$RepoRoot = Split-Path -Parent $PSScriptRoot

if (-not $ConfigPath) {
  $ConfigPath = Join-Path $RepoRoot "sync-config.json"
}

function Decode-LuaString([string]$Value) {
  $Value = $Value -replace '\\n', "`n"
  $Value = $Value -replace '\\r', "`r"
  $Value = $Value -replace '\\t', "`t"
  $Value = $Value -replace '\\"', '"'
  $Value = $Value -replace '\\\\', '\'
  return $Value
}

function Decode-Field([string]$Value) {
  if ($null -eq $Value) { return "" }
  return [System.Uri]::UnescapeDataString($Value)
}

function Find-WowRoot([string]$ConfiguredRoot) {
  if ($ConfiguredRoot -and (Test-Path $ConfiguredRoot)) {
    return (Resolve-Path $ConfiguredRoot).Path
  }

  $Candidates = @(
    (Join-Path $env:USERPROFILE "World of Warcraft\_classic_beta_"),
    "C:\Program Files (x86)\World of Warcraft\_classic_beta_",
    "C:\Program Files\World of Warcraft\_classic_beta_"
  )

  foreach ($Candidate in $Candidates) {
    if (Test-Path $Candidate) { return $Candidate }
  }

  throw "WoW Forever beta root not found."
}

function Find-SavedVariables([string]$WowRoot) {
  $AccountRoot = Join-Path $WowRoot "WTF\Account"
  $Files = Get-ChildItem -Path $AccountRoot -Filter "ForeverDB.lua" -File -Recurse |
    Sort-Object LastWriteTimeUtc -Descending

  if (-not $Files) {
    throw "ForeverDB.lua not found. Use /reload or logout once."
  }

  return $Files[0].FullName
}

function Read-Export([string]$Path) {
  $Raw = Get-Content -Path $Path -Raw
  $Match = [regex]::Match(
    $Raw,
    'ForeverDB_Export\s*=\s*"((?:\\.|[^"])*)"',
    [System.Text.RegularExpressions.RegexOptions]::Singleline
  )

  if (-not $Match.Success) {
    throw "ForeverDB_Export not found. Run /fdb export and /reload."
  }

  return Decode-LuaString $Match.Groups[1].Value
}

function Parse-QuestIds([string]$Csv) {
  $Out = @()
  if ([string]::IsNullOrWhiteSpace($Csv)) { return $Out }

  foreach ($Part in ($Csv -split ",")) {
    if ($Part -match '^\d+$') { $Out += [int64]$Part }
  }

  return $Out
}

function Parse-Export([string]$ExportText) {
  $Lines = $ExportText -split "\r?\n"
  $Header = $Lines[0] -split '\|', -1

  if ($Header.Count -lt 5 -or $Header[0] -ne "H") {
    throw "Unsupported ForeverDB export."
  }

  $SchemaVersion = [int]$Header[1]
  if ($SchemaVersion -lt 7) {
    throw "ForeverDB schema $SchemaVersion is too old. Update the addon first."
  }

  $Snapshot = [ordered]@{
    schemaVersion = $SchemaVersion
    addonVersion = $Header[2]
    installationId = $Header[3]
    updatedAt = [int64]$Header[4]
    sources = @()
  }

  $SourceMap = @{}
  $BucketMap = @{}

  for ($i = 1; $i -lt $Lines.Count; $i++) {
    $Line = $Lines[$i]
    if ([string]::IsNullOrWhiteSpace($Line)) { continue }

    $P = $Line -split '\|', -1

    switch ($P[0]) {
      "S" {
        $Key = "$($P[1])|$($P[2])|$($P[3])"
        $Source = [ordered]@{
          sourceType = $P[1]
          sourceId = [int64]$P[2]
          sourceLevel = [int]$P[3]
          name = Decode-Field $P[4]
          buckets = @()
        }
        $SourceMap[$Key] = $Source
      }

      "B" {
        $SourceKey = "$($P[1])|$($P[2])|$($P[3])"
        if (-not $SourceMap.ContainsKey($SourceKey)) {
          throw "Bucket references unknown source: $SourceKey"
        }

        $Bucket = [ordered]@{
          kind = $P[4]
          observations = [int64]$P[5]
          items = @()
          locations = @()
        }

        $SourceMap[$SourceKey].buckets += $Bucket
        $BucketMap["$SourceKey|$($P[4])"] = $Bucket
      }

      "L" {
        $BucketKey = "$($P[1])|$($P[2])|$($P[3])|$($P[4])"
        if (-not $BucketMap.ContainsKey($BucketKey)) {
          throw "Location references unknown bucket: $BucketKey"
        }

        $BucketMap[$BucketKey].locations += [ordered]@{
          mapId = [int64]$P[5]
          zoneName = Decode-Field $P[6]
          subZoneName = Decode-Field $P[7]
          x = $P[8]
          y = $P[9]
          observations = [int64]$P[10]
        }
      }

      "I" {
        $BucketKey = "$($P[1])|$($P[2])|$($P[3])|$($P[4])"
        if (-not $BucketMap.ContainsKey($BucketKey)) {
          throw "Item references unknown bucket: $BucketKey"
        }

        $BucketMap[$BucketKey].items += [ordered]@{
          itemId = [int64]$P[5]
          name = Decode-Field $P[6]
          drops = [int64]$P[7]
          quantity = [int64]$P[8]
          questDrops = [int64]$P[9]
          questIds = @(Parse-QuestIds (Decode-Field $P[10]))
        }
      }
    }
  }

  $Snapshot.sources = @($SourceMap.Values | Sort-Object sourceType, sourceId, sourceLevel)
  return $Snapshot
}

function Send-Snapshot($Config, $Snapshot) {
  $Url = $Config.supabaseUrl.TrimEnd("/") + "/rest/v1/rpc/ingest_foreverdb_snapshot"

  $Headers = @{
    apikey = $Config.supabaseKey
    Authorization = "Bearer $($Config.supabaseKey)"
  }

  $Body = @{
    p_token = $Config.ingestToken
    p_snapshot = $Snapshot
  } | ConvertTo-Json -Depth 16 -Compress

  Invoke-RestMethod -Method Post -Uri $Url -Headers $Headers -ContentType "application/json" -Body $Body
}

if (-not (Test-Path $ConfigPath)) {
  throw "Missing sync-config.json. Copy sync-config.example.json and fill it in."
}

$Config = Get-Content -Path $ConfigPath -Raw | ConvertFrom-Json
$WowRoot = Find-WowRoot $Config.wowRoot
$SavedVariables = Find-SavedVariables $WowRoot

Write-Host "ForeverDB SavedVariables:" -ForegroundColor Cyan
Write-Host $SavedVariables

$LastExport = $null

do {
  try {
    $ExportText = Read-Export $SavedVariables

    if ($ExportText -ne $LastExport) {
      $Snapshot = Parse-Export $ExportText
      $Result = Send-Snapshot $Config $Snapshot
      $LastExport = $ExportText

      Write-Host (
        "[{0}] synced {1} sources" -f
        (Get-Date -Format "HH:mm:ss"),
        $Snapshot.sources.Count
      ) -ForegroundColor Green
    }
  }
  catch {
    Write-Host ("sync error: " + $_.Exception.Message) -ForegroundColor Red
    if ($Once) { throw }
  }

  if (-not $Once) { Start-Sleep -Seconds 2 }
}
while (-not $Once)
