import { mkdir, copyFile } from 'node:fs/promises';
await mkdir('dist-electron', { recursive: true });
await copyFile('electron/main.cjs', 'dist-electron/main.cjs');
await copyFile('electron/preload.cjs', 'dist-electron/preload.cjs');
