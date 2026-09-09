# Desktop companion boundaries

- This is an independent personal Windows desktop application. Do not modify adaptive-vrm-dialogue-agent.
- Address the user as ふぁるるくん. Use plain Japanese and explain technical terms briefly.
- Implement related capabilities in a tested batch, as the user requested on 2026-09-10. Do not stop for approval at each small feature. Preserve transparent presence and reliable recovery before adding dialogue.
- Check git status before editing. Do not commit models, secrets, recordings, runtime logs, build output, or research material.
- Never infer this repository's visibility from another repository. No remote is configured initially. Ask before making it public.
- No automatic startup, constant microphone/screen capture, external AI requests, or autonomous PC actions.
- Renderer is sandboxed with context isolation and no Node integration. Validate all IPC senders and arguments.
- Models are local, explicitly selected, read-only inputs. Model and source licenses remain separate.
- Run npm run check and npm audit. Verify Windows behavior and record untested items honestly.
- Do not equate browser/API tests with native click-through or focus verification.
