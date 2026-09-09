// An isolated test target. Never use the user's documents for input tests.
const { app, BrowserWindow } = require('electron');
const path = require('node:path');
app.setName('shizuku-input-test');
app.setPath('userData', path.resolve(__dirname, '../work/fixture-userdata'));
app.whenReady().then(() => {
  const win = new BrowserWindow({ width: 760, height: 650, title: 'しずく・入力確認', backgroundColor: '#e9f2ff', webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true } });
  win.loadFile(path.join(__dirname, 'fixture.html'));
});
app.on('window-all-closed', () => app.quit());
