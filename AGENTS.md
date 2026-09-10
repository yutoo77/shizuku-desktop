# Desktop companion boundaries

- This is an independent personal Windows desktop application. Do not modify adaptive-vrm-dialogue-agent.
- Address the user as ふぁるるくん. Use plain Japanese and explain technical terms briefly.
- Implement related capabilities in a tested batch, as the user requested on 2026-09-10. Do not stop for approval at each small feature. Preserve transparent presence and reliable recovery before adding dialogue.
- Check git status before editing. Do not commit models, secrets, recordings, runtime logs, build output, or research material.
- The user explicitly approved Public source release, MIT licensing and commit-email anonymization on 2026-09-10. origin is yutoo77/shizuku-desktop. Preserve the separate old history as Private; never publish its refs, bundle or local records. Do not change account-wide privacy settings or other repositories.
- No automatic startup, constant microphone/screen capture, external AI requests, or autonomous PC actions.
- Explicit window following may read the selected window's bounds, visibility and topmost flag, and compare its immediate predecessor with our own overlay handle. Only our overlay may change stacking order. Native code must not read titles, content, input, neighbouring window properties, or manipulate other windows. Test with dedicated fixture handles/PIDs; verify foreground selection separately using native input.
- The explicit window picker may check the foreground handle and eligibility for at most 20 seconds; it must stop on selection, cancellation, timeout or exit. Never use input hooks or read window content. Native tests must restrict the picker to their dedicated fixture handle/PID.
- Pointer placement may sample cursor coordinates only during the explicit, 30-second-bounded move session. Keep the avatar click-through and never restore another app's focus by force. Treat native UI interruptions as incomplete checks.
- On system suspend or screen lock, cancel transient input, detach the selected window and hide our UI. Resume only after every rest reason clears; preserve manual hiding and never replay selection or input. Tests may emit Electron power events in their own process, but must not lock or suspend the user's PC without an explicit request.
- Renderer is sandboxed with context isolation and no Node integration. Validate all IPC senders and arguments.
- Local demo dialogue opens only after an explicit call. Keep its bridge separate from model/desktop actions, disclose that AI is not connected, retain conversation only in RAM, and abort/discard it on close, explicit hide, system rest or exit. Never reopen a conversation or replay text after restoration. Opening the chat must not steal another app's focus.
- Models are local, explicitly selected, read-only inputs. Model and source licenses remain separate.
- Run npm run check and npm audit. Verify Windows behavior and record untested items honestly.
- Do not equate browser/API tests with native click-through or focus verification.
