export {};
async function status() {
  const value = await window.companion.getStatus();
  document.querySelector('#model')!.textContent = value.model || 'モデル未選択';
  document.querySelector('#error')!.textContent = value.error;
  document.querySelector('#shortcuts')!.textContent = value.shortcuts ? '' : 'ショートカットを登録できませんでした。通知領域のアイコンから操作できます。';
  const moveButton = document.querySelector<HTMLButtonElement>('#move-mode')!;
  moveButton.textContent = value.moving ? '移動をやめる' : 'しずくをつかんで移動';
  moveButton.disabled = !value.loaded;
  moveButton.setAttribute('aria-pressed', String(value.moving));
  document.querySelector('#move-hint')!.textContent = value.moving ? 'しずくをドラッグしてね。操作がなければ30秒で戻ります。' : '矢印でも位置を調整できます。';
}
document.querySelectorAll<HTMLButtonElement>('[data-action]').forEach(button => {
  button.addEventListener('click', async () => {
    button.disabled = true;
    try { await window.companion.action(button.dataset.action as Parameters<Window['companion']['action']>[0]); await status(); }
    catch { document.querySelector('#error')!.textContent = '操作に失敗しました。通知領域のアイコンから終了・再起動できます。'; }
    finally { button.disabled = false; }
  });
});
void status();
const unsubscribe = window.companion.onStatusChanged(() => void status());
window.addEventListener('beforeunload', unsubscribe, {once:true});
window.addEventListener('focus', () => void status());
