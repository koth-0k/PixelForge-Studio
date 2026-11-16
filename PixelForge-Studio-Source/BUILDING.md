# Windows build workflow

The application source can remain on any local drive. Use a fresh C: build mirror for dependency installation and packaging. The build script derives the source root from its own location, excludes dependency trees and generated outputs while syncing, and runs `npm ci` only in the C: mirror when dependencies are absent or the lockfile changes.

From the source distribution folder, run:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\build-local.ps1 `
  -BuildRoot (Join-Path $env:LOCALAPPDATA 'PixelForgeStudio-build-YYYYMMDD') `
  -InstallerOutputDirectory (Join-Path $env:LOCALAPPDATA 'PixelForgeStudio-release-candidate-YYYYMMDD')
```

Use unique, unused paths for both arguments. The script refuses to overwrite an installer or blockmap in either the build mirror's `release` folder or the specified installer output folder. Do not select an existing release or candidate directory.

The production command runs `npm run dist:win`, which performs TypeScript checking, builds the Vite renderer and Electron main/preload files, then creates the Windows NSIS installer. On success, the script copies generated `dist` and `dist-electron` folders back to the source directory. These outputs are ignored by Git and are not required in a source checkout.

To run the automated tests after the script installs dependencies in the mirror:

```powershell
Push-Location (Join-Path $env:LOCALAPPDATA 'PixelForgeStudio-build-YYYYMMDD')
npm test
Pop-Location
```

Keep `package.json` and `package-lock.json` together. The mirror uses `npm ci` to install the exact locked dependency graph. Never install dependencies into a protected or release source tree.
