const { spawn } = require('node:child_process');
const electronExe = require('electron');
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
const child = spawn(electronExe, [process.argv[2] || '.'], { env, stdio: 'inherit', windowsHide: false });
child.on('error', error => { console.error('Could not launch Electron:', error); process.exitCode = 1; });
child.on('exit', (code, signal) => { process.exitCode = code ?? (signal ? 1 : 0); });
