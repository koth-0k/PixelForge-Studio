# PixelForge Studio

PixelForge Studio is a Windows desktop image editor built with Electron, React, TypeScript, and Vite.

## Requirements

- Windows
- Node.js and npm
- PowerShell

## Build and test

Use the C: mirror script for the Windows production build. It installs the locked dependencies in the mirror, runs TypeScript and Vite builds, packages Electron, and creates a Windows NSIS installer. Choose fresh, unused C: paths for each build:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\build-local.ps1 `
  -BuildRoot (Join-Path $env:LOCALAPPDATA 'PixelForgeStudio-build-YYYYMMDD') `
  -InstallerOutputDirectory (Join-Path $env:LOCALAPPDATA 'PixelForgeStudio-release-candidate-YYYYMMDD')
```

The script copies generated `dist` and `dist-electron` outputs back to this source folder; those paths are ignored by Git.

To run the tests after the build has installed dependencies in the mirror:

```powershell
Push-Location (Join-Path $env:LOCALAPPDATA 'PixelForgeStudio-build-YYYYMMDD')
npm test
Pop-Location
```

For local development, `npm run dev` starts Vite, `npm run build` runs the renderer and Electron production builds, and `npm run dev:desktop` starts the desktop development workflow. Run npm commands only in a working copy or the documented local mirror, not in a protected source location.

## Project documentation

- [Windows build workflow](BUILDING.md)
- [Native `.pforge` format](NATIVE_PROJECT_FORMAT.md)
- [Feature audit and known limitations](FEATURE_AUDIT.md)

No license file is included. Select and add a license before public distribution.
