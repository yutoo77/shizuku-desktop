// An isolated test target. Never use the user's documents for input tests.
const { app, BrowserWindow } = require('electron');
const path = require('node:path');
app.setName('shizuku-input-test');
app.setPath('userData', path.resolve(__dirname, '../work/fixture-userdata'));
app.whenReady().then(() => {
  const inactive = process.env.SHIZUKU_FIXTURE_INACTIVE === '1';
  const win = new BrowserWindow({ width: 760, height: 650, title: 'しずく・入力確認', show: !inactive, focusable: !inactive, backgroundColor: '#e9f2ff', webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true } });
  win.loadFile(path.join(__dirname, 'fixture.html')).then(() => { if (inactive) win.showInactive(); });
});
app.on('window-all-closed', () => app.quit());
