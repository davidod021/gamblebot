#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# deploy-gcp.sh  —  Bootstrap gamblebot on Google Cloud Run Jobs
#
# Prerequisites:
#   - gcloud CLI installed and authenticated  (gcloud auth login)
#   - Docker installed and running
#   - A .env file in this directory with your secrets
#
# Usage:
#   chmod +x deploy-gcp.sh
#   ./deploy-gcp.sh
#
# Re-running is safe: it updates the job / secrets in place.
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

# ── Configuration — edit these ───────────────────────────────────────────────
PROJECT_ID="${GCP_PROJECT_ID:-gamblebot-491717}"           # required: your GCP project ID
REGION="${GCP_REGION:-europe-west2}"       # London region — change if preferred
REPO_NAME="gamblebot"
IMAGE_NAME="${REGION}-docker.pkg.dev/${PROJECT_ID}/${REPO_NAME}/gamblebot"
JOB_NAME="gamblebot"
SCHEDULE="${CRON_SCHEDULE:-0 9 * * *}"     # 09:00 UTC daily  (adjust as needed)
SCHEDULER_JOB="gamblebot-daily"
# ─────────────────────────────────────────────────────────────────────────────

# ── Validate ─────────────────────────────────────────────────────────────────
if [[ -z "$PROJECT_ID" ]]; then
  echo "ERROR: Set GCP_PROJECT_ID env var or edit PROJECT_ID in this script."
  exit 1
fi

if [[ ! -f ".env" ]]; then
  echo "ERROR: .env file not found. Create one with your secrets first."
  exit 1
fi

echo "▶ Project:  $PROJECT_ID"
echo "▶ Region:   $REGION"
echo "▶ Image:    $IMAGE_NAME"
echo "▶ Job:      $JOB_NAME"
echo ""

# ── Enable required APIs ─────────────────────────────────────────────────────
echo "── Enabling APIs…"
gcloud services enable \
  run.googleapis.com \
  artifactregistry.googleapis.com \
  secretmanager.googleapis.com \
  cloudscheduler.googleapis.com \
  cloudbuild.googleapis.com \
  --project="$PROJECT_ID" --quiet

# ── Artifact Registry repo ───────────────────────────────────────────────────
echo "── Creating Artifact Registry repository (idempotent)…"
gcloud artifacts repositories create "$REPO_NAME" \
  --repository-format=docker \
  --location="$REGION" \
  --project="$PROJECT_ID" \
  --quiet 2>/dev/null || true   # already exists → ignore

# ── Build & push image ───────────────────────────────────────────────────────
echo "── Building Docker image…"
gcloud auth configure-docker "${REGION}-docker.pkg.dev" --quiet

docker build --platform linux/amd64 -t "${IMAGE_NAME}:latest" .
docker push "${IMAGE_NAME}:latest"

# Capture the digest so the job always runs the exact image we just pushed
DIGEST=$(docker inspect --format='{{index .RepoDigests 0}}' "${IMAGE_NAME}:latest")
if [[ -z "$DIGEST" ]]; then
  DIGEST="${IMAGE_NAME}:latest"
  echo "   Warning: could not get digest, falling back to :latest tag"
fi
echo "   Pushed: $DIGEST"

# ── Upload secrets to Secret Manager ─────────────────────────────────────────
echo "── Uploading secrets from .env…"

# Load .env, skip comments and blank lines
while IFS='=' read -r key value; do
  [[ "$key" =~ ^#.*$ || -z "$key" ]] && continue
  # Strip surrounding quotes from value
  value="${value%\"}"
  value="${value#\"}"
  value="${value%\'}"
  value="${value#\'}"

  SECRET_ID="gamblebot_${key}"

  # Create secret if it doesn't exist
  if ! gcloud secrets describe "$SECRET_ID" --project="$PROJECT_ID" &>/dev/null; then
    gcloud secrets create "$SECRET_ID" \
      --replication-policy="automatic" \
      --project="$PROJECT_ID" --quiet
  fi

  # Add / update the secret version
  printf '%s' "$value" | gcloud secrets versions add "$SECRET_ID" \
    --data-file=- \
    --project="$PROJECT_ID" --quiet

  echo "   ✓ $SECRET_ID"
done < <(grep -v '^#' .env | grep '=')

# ── Build --set-secrets flag string ──────────────────────────────────────────
# Maps ENV_VAR=SECRET_ID:latest for every key in .env
SECRETS_FLAGS=()
while IFS='=' read -r key _; do
  [[ "$key" =~ ^#.*$ || -z "$key" ]] && continue
  SECRETS_FLAGS+=("${key}=gamblebot_${key}:latest")
done < <(grep -v '^#' .env | grep '=')

SECRETS_ARG=$(IFS=','; echo "${SECRETS_FLAGS[*]}")

# ── Create / update Cloud Run Job ────────────────────────────────────────────
echo "── Deploying Cloud Run Job…"

# Grant the default compute SA access to secrets
COMPUTE_SA="${PROJECT_ID}-compute@developer.gserviceaccount.com"
for flag in "${SECRETS_FLAGS[@]}"; do
  SECRET_ID="${flag#*=}"
  SECRET_ID="${SECRET_ID%:latest}"
  gcloud secrets add-iam-policy-binding "$SECRET_ID" \
    --member="serviceAccount:${COMPUTE_SA}" \
    --role="roles/secretmanager.secretAccessor" \
    --project="$PROJECT_ID" --quiet 2>/dev/null || true
done

if gcloud run jobs describe "$JOB_NAME" --region="$REGION" --project="$PROJECT_ID" &>/dev/null; then
  gcloud run jobs update "$JOB_NAME" \
    --region="$REGION" \
    --project="$PROJECT_ID" \
    --image="$DIGEST" \
    --set-secrets="$SECRETS_ARG" \
    --memory=1Gi \
    --cpu=1 \
    --task-timeout=3600 \
    --max-retries=0 \
    --quiet
  echo "   Updated existing job."
else
  gcloud run jobs create "$JOB_NAME" \
    --region="$REGION" \
    --project="$PROJECT_ID" \
    --image="$DIGEST" \
    --set-secrets="$SECRETS_ARG" \
    --memory=1Gi \
    --cpu=1 \
    --task-timeout=3600 \
    --max-retries=0 \
    --quiet
  echo "   Created new job."
fi

# ── Cloud Scheduler trigger ───────────────────────────────────────────────────
echo "── Setting up Cloud Scheduler ($SCHEDULE)…"

# Cloud Scheduler needs a SA that can invoke Cloud Run Jobs
SCHEDULER_SA="gamblebot-scheduler@${PROJECT_ID}.iam.gserviceaccount.com"

if ! gcloud iam service-accounts describe "$SCHEDULER_SA" --project="$PROJECT_ID" &>/dev/null; then
  gcloud iam service-accounts create gamblebot-scheduler \
    --display-name="GambleBot Scheduler SA" \
    --project="$PROJECT_ID" --quiet
fi

gcloud projects add-iam-policy-binding "$PROJECT_ID" \
  --member="serviceAccount:${SCHEDULER_SA}" \
  --role="roles/run.invoker" --quiet 2>/dev/null || true

JOB_RESOURCE="projects/${PROJECT_ID}/locations/${REGION}/jobs/${JOB_NAME}"

if gcloud scheduler jobs describe "$SCHEDULER_JOB" --location="$REGION" --project="$PROJECT_ID" &>/dev/null; then
  gcloud scheduler jobs update http "$SCHEDULER_JOB" \
    --location="$REGION" \
    --project="$PROJECT_ID" \
    --schedule="$SCHEDULE" \
    --uri="https://${REGION}-run.googleapis.com/apis/run.googleapis.com/v1/namespaces/${PROJECT_ID}/jobs/${JOB_NAME}:run" \
    --message-body="{}" \
    --oauth-service-account-email="$SCHEDULER_SA" \
    --quiet
  echo "   Updated scheduler job."
else
  gcloud scheduler jobs create http "$SCHEDULER_JOB" \
    --location="$REGION" \
    --project="$PROJECT_ID" \
    --schedule="$SCHEDULE" \
    --uri="https://${REGION}-run.googleapis.com/apis/run.googleapis.com/v1/namespaces/${PROJECT_ID}/jobs/${JOB_NAME}:run" \
    --message-body="{}" \
    --oauth-service-account-email="$SCHEDULER_SA" \
    --quiet
  echo "   Created scheduler job."
fi

# ── Done ─────────────────────────────────────────────────────────────────────
echo ""
echo "✅ Deployment complete!"
echo ""
echo "Run manually:"
echo "  gcloud run jobs execute $JOB_NAME --region=$REGION --project=$PROJECT_ID --wait"
echo ""
echo "View logs:"
echo "  gcloud run jobs executions list --job=$JOB_NAME --region=$REGION --project=$PROJECT_ID"
echo "  gcloud logging read 'resource.type=cloud_run_job AND resource.labels.job_name=$JOB_NAME' --project=$PROJECT_ID --limit=50"
echo ""
echo "Trigger manually now? Run:"
echo "  gcloud run jobs execute $JOB_NAME --region=$REGION --project=$PROJECT_ID"

exit 0
