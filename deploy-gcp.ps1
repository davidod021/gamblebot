# ─────────────────────────────────────────────────────────────────────────────
# deploy-gcp.ps1  —  Bootstrap gamblebot on Google Cloud Run Jobs
#
# Prerequisites:
#   - gcloud CLI installed and authenticated  (gcloud auth login)
#   - Docker installed and running
#   - A .env file in this directory with your secrets
#
# Usage:
#   .\deploy-gcp.ps1
#
# Re-running is safe: it updates the job / secrets in place.
# ─────────────────────────────────────────────────────────────────────────────
$ErrorActionPreference = "Continue"

# ── Configuration — edit these ───────────────────────────────────────────────
$ProjectId    = if ($env:GCP_PROJECT_ID)   { $env:GCP_PROJECT_ID }   else { "gamblebot-491717" }
$Region       = if ($env:GCP_REGION)       { $env:GCP_REGION }       else { "europe-west2" }
$RepoName     = "gamblebot"
$ImageName    = "$Region-docker.pkg.dev/$ProjectId/$RepoName/gamblebot"
$JobName      = "gamblebot"
$Schedule     = if ($env:CRON_SCHEDULE)    { $env:CRON_SCHEDULE }    else { "0 9 * * *" }
$SchedulerJob = "gamblebot-daily"
# ─────────────────────────────────────────────────────────────────────────────

# ── Validate ─────────────────────────────────────────────────────────────────
if (-not $ProjectId) {
    Write-Error "ERROR: Set GCP_PROJECT_ID env var or edit `$ProjectId in this script."
    exit 1
}

if (-not (Test-Path ".env")) {
    Write-Error "ERROR: .env file not found. Create one with your secrets first."
    exit 1
}

Write-Host ">> Project:  $ProjectId"
Write-Host ">> Region:   $Region"
Write-Host ">> Image:    $ImageName"
Write-Host ">> Job:      $JobName"
Write-Host ""

# ── Enable required APIs ─────────────────────────────────────────────────────
Write-Host "-- Enabling APIs..."
gcloud services enable `
    run.googleapis.com `
    artifactregistry.googleapis.com `
    secretmanager.googleapis.com `
    cloudscheduler.googleapis.com `
    cloudbuild.googleapis.com `
    --project=$ProjectId --quiet

# ── Artifact Registry repo ───────────────────────────────────────────────────
Write-Host "-- Creating Artifact Registry repository (idempotent)..."
gcloud artifacts repositories create $RepoName `
    --repository-format=docker `
    --location=$Region `
    --project=$ProjectId `
    --quiet 2>$null
# Ignore exit code — error just means it already exists
$LASTEXITCODE = 0

# ── Build & push image ───────────────────────────────────────────────────────
Write-Host "-- Building Docker image..."
gcloud auth configure-docker "$Region-docker.pkg.dev" --quiet

docker build --platform linux/amd64 -t "${ImageName}:latest" .
docker push "${ImageName}:latest"

# Capture the digest so the job always runs the exact image we just pushed
$Digest = docker inspect --format='{{index .RepoDigests 0}}' "${ImageName}:latest"
if (-not $Digest) {
    $Digest = "${ImageName}:latest"
    Write-Host "   Warning: could not get digest, falling back to :latest tag"
}
Write-Host "   Pushed: $Digest"

# ── Upload secrets to Secret Manager ─────────────────────────────────────────
Write-Host "-- Uploading secrets from .env..."

# Parse .env — skip comments and blank lines, strip surrounding quotes
$EnvVars = @{}
Get-Content ".env" | Where-Object { $_ -notmatch '^\s*#' -and $_ -match '=' } | ForEach-Object {
    $parts = $_ -split '=', 2
    $key   = $parts[0].Trim()
    $value = $parts[1].Trim().Trim('"').Trim("'")
    if ($key) { $EnvVars[$key] = $value }
}

foreach ($key in $EnvVars.Keys) {
    $SecretId = "gamblebot_$key"

    # Create secret if it doesn't exist
    $exists = gcloud secrets describe $SecretId --project=$ProjectId 2>$null
    if ($LASTEXITCODE -ne 0) {
        gcloud secrets create $SecretId `
            --replication-policy="automatic" `
            --project=$ProjectId --quiet
    }

    # Write value to a temp file (avoids shell escaping issues with special chars)
    $TmpFile = [System.IO.Path]::GetTempFileName()
    [System.IO.File]::WriteAllText($TmpFile, $EnvVars[$key], (New-Object System.Text.UTF8Encoding $false))

    gcloud secrets versions add $SecretId `
        --data-file=$TmpFile `
        --project=$ProjectId --quiet

    Remove-Item $TmpFile -Force
    Write-Host "   OK $SecretId"
}

# ── Build --set-secrets flag string ──────────────────────────────────────────
$SecretsArg = ($EnvVars.Keys | ForEach-Object { "$_=gamblebot_${_}:latest" }) -join ","

# ── Grant compute SA access to secrets ───────────────────────────────────────
Write-Host "-- Granting Secret Manager access..."
$ComputeSa = "$ProjectId-compute@developer.gserviceaccount.com"
foreach ($key in $EnvVars.Keys) {
    $SecretId = "gamblebot_$key"
    gcloud secrets add-iam-policy-binding $SecretId `
        --member="serviceAccount:$ComputeSa" `
        --role="roles/secretmanager.secretAccessor" `
        --project=$ProjectId --quiet 2>$null
    $LASTEXITCODE = 0
}

# ── Create / update Cloud Run Job ────────────────────────────────────────────
Write-Host "-- Deploying Cloud Run Job..."

$jobExists = gcloud run jobs describe $JobName --region=$Region --project=$ProjectId 2>$null
if ($LASTEXITCODE -eq 0) {
    gcloud run jobs update $JobName `
        --region=$Region `
        --project=$ProjectId `
        --image=$Digest `
        --set-secrets=$SecretsArg `
        --memory=1Gi `
        --cpu=1 `
        --task-timeout=3600 `
        --max-retries=0 `
        --quiet
    Write-Host "   Updated existing job."
} else {
    gcloud run jobs create $JobName `
        --region=$Region `
        --project=$ProjectId `
        --image=$Digest `
        --set-secrets=$SecretsArg `
        --memory=1Gi `
        --cpu=1 `
        --task-timeout=3600 `
        --max-retries=0 `
        --quiet
    Write-Host "   Created new job."
}

# ── Cloud Scheduler trigger ───────────────────────────────────────────────────
Write-Host "-- Setting up Cloud Scheduler ($Schedule)..."

$SchedulerSa = "gamblebot-scheduler@$ProjectId.iam.gserviceaccount.com"

$saExists = gcloud iam service-accounts describe $SchedulerSa --project=$ProjectId 2>$null
if ($LASTEXITCODE -ne 0) {
    gcloud iam service-accounts create gamblebot-scheduler `
        --display-name="GambleBot Scheduler SA" `
        --project=$ProjectId --quiet
}

gcloud projects add-iam-policy-binding $ProjectId `
    --member="serviceAccount:$SchedulerSa" `
    --role="roles/run.invoker" --quiet 2>$null
$LASTEXITCODE = 0

$RunUri = "https://$Region-run.googleapis.com/apis/run.googleapis.com/v1/namespaces/$ProjectId/jobs/${JobName}:run"

$schedulerExists = gcloud scheduler jobs describe $SchedulerJob --location=$Region --project=$ProjectId 2>$null
if ($LASTEXITCODE -eq 0) {
    gcloud scheduler jobs update http $SchedulerJob `
        --location=$Region `
        --project=$ProjectId `
        --schedule=$Schedule `
        --uri=$RunUri `
        --message-body="{}" `
        --oauth-service-account-email=$SchedulerSa `
        --quiet
    Write-Host "   Updated scheduler job."
} else {
    gcloud scheduler jobs create http $SchedulerJob `
        --location=$Region `
        --project=$ProjectId `
        --schedule=$Schedule `
        --uri=$RunUri `
        --message-body="{}" `
        --oauth-service-account-email=$SchedulerSa `
        --quiet
    Write-Host "   Created scheduler job."
}

# ── Done ─────────────────────────────────────────────────────────────────────
Write-Host ""
Write-Host "Deployment complete!"
Write-Host ""
Write-Host "Run manually:"
Write-Host "  gcloud run jobs execute $JobName --region=$Region --project=$ProjectId --wait"
Write-Host ""
Write-Host "View logs:"
Write-Host "  gcloud run jobs executions list --job=$JobName --region=$Region --project=$ProjectId"
Write-Host "  gcloud logging read 'resource.type=cloud_run_job AND resource.labels.job_name=$JobName' --project=$ProjectId --limit=50"
