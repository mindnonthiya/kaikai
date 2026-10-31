$ErrorActionPreference = 'Stop'
$costRoot = Split-Path -Parent $PSScriptRoot
$costContainer = 'kaikai-cost-test-' + [guid]::NewGuid().ToString('N').Substring(0, 12)
function Invoke-CostDocker {
    & docker @args
    if ($LASTEXITCODE -ne 0) { throw "Database test command failed (exit $LASTEXITCODE)" }
}
try {
    Invoke-CostDocker run --detach --name $costContainer --env POSTGRES_HOST_AUTH_METHOD=trust postgres:16
    $costReady = $false
    for ($costAttempt = 0; $costAttempt -lt 30; $costAttempt++) {
        & docker exec $costContainer pg_isready -U postgres 2>$null | Out-Null
        if ($LASTEXITCODE -eq 0) { $costReady = $true; break }
        Start-Sleep -Milliseconds 1000
    }
    if (-not $costReady) { throw 'Test PostgreSQL did not become ready' }
    Invoke-CostDocker cp "$costRoot/scripts/fixtures/costing-bootstrap.sql" "${costContainer}:/tmp/bootstrap.sql"
    Invoke-CostDocker cp "$costRoot/supabase/migrations" "${costContainer}:/tmp/migrations"
    Invoke-CostDocker cp "$costRoot/scripts/fixtures/order-costing.sql" "${costContainer}:/tmp/test.sql"
    Invoke-CostDocker exec $costContainer psql -U postgres -v ON_ERROR_STOP=1 -q -f /tmp/bootstrap.sql
    $costMigrations = @('202610130001_initial_schema.sql','202610130002_app_data.sql','202610140001_packaging_delivery.sql','202610150001_costing_v2.sql','202610150005_sale_tips_and_custom_items.sql','202610260001_keep_pooled_cost_in_cost_recalculation.sql','202611010001_order_cost_consistency.sql')
    foreach ($costMigration in $costMigrations) {
        Invoke-CostDocker exec $costContainer psql -U postgres -v ON_ERROR_STOP=1 -q -f "/tmp/migrations/$costMigration"
    }
    Invoke-CostDocker exec $costContainer psql -U postgres -v ON_ERROR_STOP=1 -q -f /tmp/test.sql
} finally {
    # Only the isolated container created above is removed; no host database or volume is used.
    & docker rm --force $costContainer | Out-Null
}
