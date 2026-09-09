export {};

type CompanionStatus = Awaited<ReturnType<Window['companion']['getStatus']>>;
type CompanionAction = Parameters<Window['companion']['action']>[0];
const buttons = document.querySelectorAll<HTMLButtonElement>('button[data-action]');
const sizes = document.querySelectorAll<HTMLInputElement>('input[name="size"]');
const postures = document.querySelectorAll<HTMLInputElement>('input[name="posture"]');
const facings = document.querySelectorAll<HTMLInputElement>('input[name="facing"]');
const moveButton = document.querySelector<HTMLButtonElement>('#move-mode')!;
const callButton = document.querySelector<HTMLButtonElement>('#call')!;
const seatButton = document.querySelector<HTMLButtonElement>('#seat')!;
const quietButton = document.querySelector<HTMLButtonElement>('#quiet')!;
const followButton = document.querySelector<HTMLButtonElement>('#follow')!;
let currentStatus: CompanionStatus | null = null;
let busy = false;
let requestVersion = 0;
let operationError = '';

function renderStatus(): void {
  for (const button of buttons) {
    button.disabled = busy || ((button === moveButton || button === callButton || button === seatButton) && !currentStatus?.loaded)
      || (button.dataset.action === 'restore-favorite' && !currentStatus?.hasFavorite);
    if (button === followButton) button.disabled = busy || !currentStatus?.loaded || !currentStatus.followReady;
  }
  for (const radio of sizes) {
    radio.disabled = busy || currentStatus === null;
    radio.checked = Number(radio.value) === currentStatus?.scale;
  }
  for (const radio of postures) {
    radio.disabled = busy || currentStatus === null;
    radio.checked = radio.value === currentStatus?.posture;
  }
  for (const radio of facings) {
    radio.disabled = busy || currentStatus === null;
    radio.checked = radio.value === currentStatus?.facing;
  }
  document.querySelector('#error')!.textContent = operationError || currentStatus?.error || '';
  if (!currentStatus) return;
  document.querySelector('#model')!.textContent = currentStatus.model || 'モデル未選択';
  document.querySelector('#shortcuts')!.textContent = currentStatus.shortcuts ? '' : 'ショートカットを登録できませんでした。通知領域のアイコンから操作できます。';
  moveButton.textContent = currentStatus.moving ? '移動をやめる' : 'しずくをつかんで移動';
  moveButton.setAttribute('aria-pressed', String(currentStatus.moving));
  seatButton.textContent = currentStatus.seatCountdown || currentStatus.seating ? '場所の指定をやめる' : '3秒後のポインター位置に座る';
  quietButton.setAttribute('aria-pressed', String(currentStatus.quiet));
  quietButton.textContent = currentStatus.quiet ? '動きを戻す' : '動きを休める';
  followButton.textContent = currentStatus.following || currentStatus.followCountdown ? '窓の追従をやめる' : '3秒後に選んだ窓に座る';
  followButton.setAttribute('aria-pressed', String(currentStatus.following || !!currentStatus.followCountdown));
  document.querySelector('#move-hint')!.textContent = currentStatus.followMessage || (currentStatus.seatCountdown
    ? `あと${currentStatus.seatCountdown}秒。座らせたい場所へポインターを動かしてね。`
    : currentStatus.seating ? '座る位置を合わせています。'
    : currentStatus.moving ? 'しずくをドラッグしてね。操作がなければ30秒で戻ります。'
    : currentStatus.placementMessage || '矢印でも位置を調整できます。');
}

async function status(): Promise<void> {
  const version = ++requestVersion;
  try {
    const value = await window.companion.getStatus();
    if (version !== requestVersion) return;
    currentStatus = value;
  } catch {
    if (version !== requestVersion) return;
    operationError ||= '状態を確認できませんでした。通知領域のアイコンから終了・再起動できます。';
  }
  renderStatus();
}

async function perform(action: CompanionAction): Promise<void> {
  if (busy) return;
  busy = true;
  operationError = '';
  renderStatus();
  try {
    await window.companion.action(action);
  } catch {
    operationError = '操作に失敗しました。通知領域のアイコンから終了・再起動できます。';
  } finally {
    // Read the confirmed value before enabling input again. A failed resize also
    // restores the previous radio selection; an unloaded model keeps Move disabled.
    await status();
    busy = false;
    renderStatus();
  }
}

for (const button of buttons) {
  button.addEventListener('click', () => void perform(button.dataset.action as CompanionAction));
}
for (const radio of [...sizes, ...postures, ...facings]) {
  radio.addEventListener('change', () => {
    if (radio.checked) void perform(radio.dataset.action as CompanionAction);
  });
}
renderStatus();
void status();
const unsubscribe = window.companion.onStatusChanged(() => void status());
window.addEventListener('beforeunload', unsubscribe, {once: true});
window.addEventListener('focus', () => void status());
