# Desktop companion boundaries

- This is an independent personal Windows desktop application. Do not modify adaptive-vrm-dialogue-agent.
- Address the user as ふぁるるくん. Use plain Japanese and explain technical terms briefly.
- Implement related capabilities in a tested batch, as the user requested on 2026-09-10. Do not stop for approval at each small feature. Preserve transparent presence and reliable recovery before adding dialogue.
- Check git status before editing. Do not commit models, secrets, recordings, runtime logs, build output, or research material.
- Never infer this repository's visibility from another repository. No remote is configured initially. Ask before making it public.
- No automatic startup, constant microphone/screen capture, external AI requests, or autonomous PC actions.
- Explicit window following may read only the selected window's bounds/visibility. Native code must not read titles, content, input, or manipulate other windows. Test with dedicated fixture handles/PIDs; verify foreground selection separately using native input.
- Pointer placement may sample cursor coordinates only during the explicit, 30-second-bounded move session. Keep the avatar click-through and never restore another app's focus by force. Treat native UI interruptions as incomplete checks.
- Renderer is sandboxed with context isolation and no Node integration. Validate all IPC senders and arguments.
- Models are local, explicitly selected, read-only inputs. Model and source licenses remain separate.
- Run npm run check and npm audit. Verify Windows behavior and record untested items honestly.
- Do not equate browser/API tests with native click-through or focus verification.
