# Free Limits And Local Survival

This project is designed to keep working without paid AI access.

## Best Daily Strategy

```text
Normal questions       -> Auto balanced
Compare answers        -> Auto compare, only when needed
Project/file edits     -> OpenCode Agent
Long free sessions     -> Auto survival / Ollama
Cloud quota exhausted  -> Ollama qwen2.5-coder:3b
```

## Current Practical Limits

These limits can change, so always trust the provider dashboards over this note.

```text
Ollama local
- No API quota.
- Limited by laptop speed, RAM, VRAM, and disk.
- Current repaired model: qwen2.5-coder:3b in C:\OllamaModels.

Cerebras gpt-oss-120b free trial
- 5 RPM
- 30K TPM
- 1M TPH
- 1M TPD

Groq llama-3.1-8b-instant free
- 60 RPM
- 1K RPD
- 6K TPM
- 500K TPD

OpenRouter :free models
- 20 requests per minute
- 50 free-model requests per day without $10+ purchased credits
- 1000 free-model requests per day after $10+ purchased credits

Gemini API
- Limits depend on project usage tier and account status.
- Exact active limits are shown in Google AI Studio.
```

## Why Ollama Matters

OpenCode can consume cloud quota quickly because agent mode reads context and may do several internal steps. Ollama is the "survival" layer: slower, but it keeps working when free cloud providers hit limits.

## Repairing Ollama On Windows

If Ollama fails with a path like:

```text
C:\Users\�����\.ollama\models\...
```

move the model store to an ASCII path:

```powershell
.\scripts\Repair-OllamaLocalModels.ps1
```

The script sets:

```text
OLLAMA_MODELS=C:\OllamaModels
```

Then it restarts Ollama, verifies the requested model, and tests it through the HTTP API with a timeout.

For Gemma Local:

```powershell
.\scripts\Repair-OllamaLocalModels.ps1 -Model gemma3:4b
```

The environment variable must be present on the Ollama server process. Setting it only on an `ollama run` client does not change the model directory used by an already-running server.

## Sources

- Cerebras rate limits: https://inference-docs.cerebras.ai/support/rate-limits
- Groq rate limits: https://console.groq.com/docs/rate-limits
- OpenRouter limits: https://openrouter.ai/docs/api/reference/limits
- Gemini API rate limits: https://ai.google.dev/gemini-api/docs/rate-limits
