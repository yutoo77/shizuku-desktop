# Desktop companion boundaries

- This is an independent personal Windows desktop application. Do not modify adaptive-vrm-dialogue-agent.
- Address the user as ふぁるるくん. Use plain Japanese and explain technical terms briefly.
- Implement one major capability at a time. The first slice is transparent presence and reliable recovery, not dialogue.
- Check git status before editing. Do not commit models, secrets, recordings, runtime logs, build output, or research material.
- Never infer this repository's visibility from another repository. No remote is configured initially. Ask before making it public.
- No automatic startup, constant microphone/screen capture, external AI requests, or autonomous PC actions.
- Renderer is sandboxed with context isolation and no Node integration. Validate all IPC senders and arguments.
- Models are local, explicitly selected, read-only inputs. Model and source licenses remain separate.
- Run npm run check and npm audit. Verify Windows behavior and record untested items honestly.
- Do not equate browser/API tests with native click-through or focus verification.
