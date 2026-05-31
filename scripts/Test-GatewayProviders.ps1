param(
    [string[]]$Providers = @("open_router", "gemini", "groq", "cerebras", "mistral", "mistral_codestral", "ollama"),

    [string]$GatewayUrl = "http://127.0.0.1:8082"
)

$ErrorActionPreference = "Continue"

foreach ($provider in $Providers) {
    Write-Host ""
    Write-Host "== $provider =="

    try {
        $result = Invoke-RestMethod `
            -Uri "$GatewayUrl/admin/api/providers/$provider/test" `
            -Method Post `
            -TimeoutSec 60

        if ($result.ok -eq $false) {
            Write-Host "Status: FAIL"
            Write-Host "Error:  $($result.error_type)"
            continue
        }

        $models = @($result.models)
        Write-Host "Status: OK"
        Write-Host "Models: $($models.Count)"
        $models | Select-Object -First 10 | ForEach-Object {
            Write-Host " - $_"
        }
    } catch {
        Write-Host "Status: FAIL"
        if ($_.ErrorDetails.Message) {
            Write-Host "Error:  $($_.ErrorDetails.Message)"
        } else {
            Write-Host "Error:  $($_.Exception.Message)"
        }
    }
}

