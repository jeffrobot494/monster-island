# claude -p probe results (milestone 1, 2026-10-09, Claude Code 2.1.295)

- Schema output lives at `envelope.structured_output` (also stringified in `envelope.result`). `is_error` flags failure.
- `--json-schema` works with `--tools ""` and `--safe-mode` together.
- `--system-prompt-file` exists (hidden from --help) and works.
- **The child process must not inherit `ANTHROPIC_API_KEY`**: if set, the CLI uses it instead of the subscription
  (the dev's ~/.bashrc exports one → "Invalid API key"). The middleware strips it, plus `CLAUDECODE`/`CLAUDE_CODE_*` session vars.
- Latency: sonnet tiny structured call ≈ 3 s; opus ≈ 4.3K output tokens of code ≈ 34 s.
