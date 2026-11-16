# PixelForge Studio Feature Audit

## Executive summary

PixelForge Studio has a substantial working foundation for straightforward raster editing: multi-document tabs, native `.pforge` projects, raster and vector layers, groups, masks, selection tools, editable text and shapes, non-destructive adjustments/effects, and undo/redo. Source and focused tests support those capabilities; this is more than a static UI prototype.

It is not yet a professional general-purpose image editor. A linear/radial gradient tool and contiguous/global flood fill are available, along with clone stamping and a local-mean healing brush; these are destructive raster edits on the selected layer or mask. Major workflow gaps remain in spot healing, liquify/warping, editable Bézier paths, full layer transforms, color management, and broad import/export formats. The history cursor issue and unbounded document-allocation risk identified in the original audit have since been addressed by follow-up milestones. Large-document work now has explicit dimension, pixel, file, decoded-asset, history, and cache limits, but renderer memory still depends on layer count, browser allocation behavior, and full-canvas processing for complex stacks.

**Overall assessment:** useful baseline editor for modest documents; significant work remains for dependable professional production use, especially around resource safety, format coverage, color fidelity, and missing core workflows. A final release-readiness review also fixed quadratic wrapping work for long unbroken text and added regression coverage.

## Scope and method

- Reviewed the application entry point and UI, editor/document model, selection, mask, brush, vector, path, channel, and adjustment engines, project serialization/validation, Electron main/preload boundary, tests, package scripts, `BUILDING.md`, and `NATIVE_PROJECT_FORMAT.md`.
- Inspected the built renderer UI read-only. The shared development page was unavailable, so live development-server interactions were not validated.
- Ran `npm test`: **69 passed, 0 failed** in the latest regression run. Dependencies were installed only in a C: build mirror, never on G:.
- This is a feature/engineering audit, not a penetration test or a complete manual GUI acceptance pass. “Complete” below means the stated bounded capability is evidenced in source and/or focused tests; it does not mean parity with a commercial editor.

### Status definitions

- **COMPLETE** — the specific bounded capability is implemented and supported by source/tests.
- **PARTIAL** — a useful implementation exists, with material workflow, format, or scale limitations.
- **MISSING** — no functional implementation was found.
- **UNVERIFIED** — source inspection or existing automated tests do not establish that it works reliably in practice.

## Project structure and evidence map

| Area | Role |
|---|---|
| `src/` | React/TypeScript UI, editor model, and feature engines. `App.tsx` coordinates document state, panels, tools, rendering, and commands. |
| `electron/` | Main process, preload bridge, native dialogs, and file operations. |
| `tests/` | Node-based focused regression tests for project format, selections/masks/layers, paths/channels, and adjustments. |
| `NATIVE_PROJECT_FORMAT.md` | Native `.pforge` format documentation. |
| `BUILDING.md`, `scripts/build-local.ps1` | Documented local C: mirror build workflow; the G: dependency tree is not the documented build environment. |
| `dist/`, `dist-electron/` | Generated renderer and Electron output; not application source of truth. |
| `release*/`, backups, `node_modules.interrupted` | Existing release and recovery artifacts. They were not changed. |

The root also contains duplicate-looking nested directories such as `src/src`, `electron/electron`, `scripts/scripts`, `dist/dist`, and `dist-electron/dist-electron`. `tsconfig.json` excludes `src/src`; the active build entry points are at the root-level directories. These copies and generated outputs increase source-of-truth confusion and should be inventoried before any future cleanup. No cleanup was performed.

## Feature inventory

| Area / capability | Status | Evidence and scope |
|---|---|---|
| Canvas display and zoom | **PARTIAL** | Zoom range, zoom controls, and fit-to-window are present. The canvas area can scroll, but there is no verified zoom-at-cursor or robust navigation workflow. |
| Hand/pan tool | **MISSING** | A Hand tool is listed, but pointer handling returns early for it and no pan handler was found. Scrollbars are the available navigation fallback. |
| Multiple documents | **COMPLETE** | Documents have per-document editor state and tabs; activation restores layers, selection, paths, channel view, adjustments, background, and zoom. |
| New document and close workflow | **COMPLETE** | New-document dimensions are validated; document and application close flows offer save, discard, or cancel for unsaved changes. |
| Layers and groups | **PARTIAL** | Pixel, text, shape, adjustment, and group layer models exist. Duplicate, rename, reorder, visibility, lock, opacity, blend modes, group/ungroup, delete, and merge workflows are present. Professional-grade tree ergonomics and integration coverage remain limited. |
| Layer masks | **COMPLETE** for basic grayscale masks; **PARTIAL** overall | Mask create/remove, visibility/enabling, invert, independent mask painting, and persistence are implemented. The mask remains a raster mask rather than a richer mask/channel system; group and complex nested workflows need broader integration testing. |
| Selection tools and operations | **PARTIAL** | Rectangular/elliptical marquee, row/column, freehand and polygon lasso, magic wand, combine modes, invert/deselect, feather, expand/contract, transforms, boundary rendering, and project persistence exist. Advanced selection refinement and UI/large-image stress coverage are limited. |
| Paths | **PARTIAL** | Paths can be created, selected, renamed, shown/hidden, deleted, converted from supported shapes or selections, rendered, and serialized. They are straight-segment outlines; Bézier handles, node editing, and a full pen-tool workflow are absent. |
| Brush and eraser | **PARTIAL** | Raster brush/eraser and mask painting support configurable stamps, pressure-related behavior, spacing/smoothing, and brush settings. Brush-engine behavior lacks focused automated coverage; advanced dynamics, brush authoring, and production retouch tools are absent. |
| Gradients and fills | **PARTIAL** | Linear/radial gradients, foreground-to-background, foreground-to-transparent and custom multi-stop gradients, opacity, supported blend modes, selection coverage, and editable layer-mask targeting are available as raster paint operations. Flood fill supports contiguous/global matching, tolerance, antialias coverage, alpha-aware matching, selection/mask targeting, and foreground/background colors. These operations are destructive raster edits; there are no editable gradient layers or pattern fills. Focused engine and `.pforge` raster round-trip tests exist; UI interaction is not covered by automated tests. |
| Text and typography | **PARTIAL** | Text is stored as editable vector-layer data with font, size, weight, alignment, color, tracking, line spacing, box size, and basic styling. Advanced typography, font embedding, rich text, and portable font fidelity are not established. |
| Shapes and vector editing | **PARTIAL** | Editable rectangle, rounded rectangle, ellipse, line, polygon, and star layers are supported. Shape-to-path conversion exists, but direct vector node editing and broad SVG interoperability are absent. |
| Crop, resize, rotate, transform | **PARTIAL** | Crop, image resize/resampling, canvas quarter-turn rotation/flips, and layer move/resize are implemented. Arbitrary layer rotation, perspective, mesh transforms, and warping are not established. |
| Adjustments and effects | **COMPLETE** for implemented adjustment/effect stack; **PARTIAL** as a professional suite | Non-destructive brightness/contrast, exposure, hue/saturation, levels, color balance, grayscale, and invert adjustments, plus editable/reorderable/enabled effect stacks, are represented and persisted. Curves and a broader filter catalog are absent. |
| Channels | **PARTIAL** | RGB composite and red/green/blue/alpha preview modes are implemented and explicitly labeled preview-only. They do not edit pixels; arbitrary saved channels, spot channels, and channel editing are absent. |
| Color management | **MISSING** | No ICC profile assignment/conversion, CMYK workflow, soft proofing, or bit-depth pipeline was found. The UI presents RGB/8-like assumptions rather than a managed color workflow. |
| Clone stamp and healing | **PARTIAL** | Clone stamping supports Alt-click sources, aligned/non-aligned strokes, offsets, active-layer or merged-visible sampling, brush dynamics, selection coverage, enabled-mask constraints, and direct mask targeting. Healing transfers sampled texture with alpha-weighted local-mean colour compensation. Strokes are tile-undoable and raster project pixels persist. Spot healing, dodge/burn, smudge, dedicated React/Electron interaction tests, and broad real-renderer stress tests are absent. |
| Liquify and warping | **MISSING** | No liquify, mesh deformation, or warp workflow was found. |
| Undo/redo and history | **PARTIAL** | Per-document history, undo/redo, history navigation, dirty-state tracking, pixel-tile history, cursor rebasing, and byte-budget trimming are implemented and covered by focused regression tests. UI-level save/close timing and real-renderer interaction coverage remain limited. |
| Native project save/open | **COMPLETE** for the documented `.pforge` v1 scope | Serialization covers document/layer data, masks, selections including previous selection, paths, and effects. Validation checks structures, dimensions, assets, and digests; project-format regression tests pass. |
| Raster import/export | **PARTIAL** | PNG/JPEG/WebP/BMP/GIF are accepted in renderer paths; PNG export is available. The native Open dialog also advertises TIFF/TIF, but renderer accepted-format lists omit them. No broad export-format or color-profile workflow exists. |
| Performance and large documents | **PARTIAL** | Document/image dimensions and project assets are preflighted; history and render caches are bounded, and simple eligible stacks can redraw a dirty region. Complex stacks still use full-canvas surfaces or pixel buffers on the renderer thread, so practical capacity depends on layer count and available memory. |
| Keyboard shortcuts | **PARTIAL** | Common file, edit, selection, layer, and tool shortcuts are implemented. Shortcut discoverability and coverage are incomplete; the advertised Hand tool is not functional. |
| Workspace and usability | **PARTIAL** | Docked panels, layer/path/channel/history panels, tool controls, status/zoom controls, tooltips, and preferences exist. Workspace customization, comprehensive accessibility verification, and consistent end-to-end interaction testing are lacking. |
| Extensibility and automation | **MISSING** | No documented plugin API, scripting interface, batch-processing API, or automation model was found. |
| Electron security boundary | **COMPLETE** for inspected isolation controls; **UNVERIFIED** as a full security assessment | Context isolation, disabled Node integration, sandboxing, a narrow preload bridge, and trusted-main-frame checks are present. This audit did not attempt adversarial security testing. |

## Known limitations and risks

### Workflow limitations

- **Document memory is bounded but not globally predictable.** The safety work limits a document to 8,192 pixels per side and 16,777,216 pixels (64 MiB per RGBA surface), caps project/import sizes, aggregate decoded project pixels, history bytes, render-cache bytes, and selection tile references, and validates before decode/allocation. These guards do not guarantee that a browser can allocate every permitted combination of layers, masks, effects, and temporary surfaces; allocation failures are surfaced, but real-renderer stress behavior remains unverified.
- **Import dialog and renderer format handling disagree.** Electron's native Open Image dialog advertises TIFF/TIF, while renderer accepted-image extension/MIME sets omit both. The dialog can therefore offer files the application cannot decode. PNG/JPEG/WebP/BMP/GIF imports have byte and dimension preflight checks.
- **The Hand tool appears inert.** It is present in the tool list, but pointer processing exits early for it and no drag-to-pan behavior was found.

### Performance and engineering risks

- Complex rendering and effects still operate on full-canvas surfaces/pixel buffers on the renderer thread. Bounded isolated-layer and mask-alpha caches reduce repeated work, and regional redraw is restricted to simple source-over pixel stacks; no worker/offscreen rendering pipeline exists.
- Flood fill reads a complete raster or mask into an `ImageData` buffer and allocates a coverage map (plus a bounded typed-array traversal queue for contiguous fills). Peak temporary memory and main-thread latency can therefore be significant near the maximum supported document size; no large-document timing benchmark has been run for this tool.
- Text wrapping now measures long unbroken words incrementally instead of remeasuring every growing prefix. Text layers still allow up to two million characters, and per-character spacing/rendering can remain slow for unusually large text; no long-text renderer benchmark has been run.
- The maximum selection scan limit in path conversion is a useful safeguard, but equivalent document-wide resource budgeting is not evident across all operations.
- Several regression tests use mocked canvas/image decoding rather than a real browser/Electron renderer. They establish engine/data behavior but not actual renderer memory behavior, UI event timing, or native file-dialog integration.
- Duplicate-looking nested source/generated directories and many retained release candidates/backups make it easier to inspect or build the wrong copy. The documented mirror build workflow should remain the authority; the audit did not modify these artifacts.
- `readPrefs` logs preference contents and returns an empty object on non-ENOENT failures. This is a minor robustness/privacy concern compared with editor issues; review whether preference values belong in logs and whether failures should be surfaced to the user.
- No lint script was found in the package scripts.

## Test coverage

### Existing automated coverage

`npm test` most recently completed with **69 passed, 0 failed**. Test files cover:

- Native project parsing, serialization, validation, and compatibility cases.
- Selection and mask helpers plus layer workflows.
- Paths and channel preview helpers.
- Adjustment/effect processing and persistence.
- Linear measurement work for long unbroken text wrapping.

### Important gaps

- No React UI or Electron end-to-end tests for dialogs, failed saves, dirty indicators, close prompts, keyboard shortcuts, or multi-document interactions.
- History cursor trimming, memory-budget trimming, saved checkpoints, and multi-document model isolation have focused tests. UI-level history navigation and save/close timing still lack Electron integration coverage.
- No real-renderer tests for brush pressure/strokes, masks composited with visibility/opacity/blend modes, path interactions, channel previews, or actual saved-image fidelity.
- Resource tests cover exact dimension/pixel limits, image-header parsing, allocation failure, bounded caches, regional redraw eligibility, and history-budget trimming. Real-renderer stress tests for many layers, nested groups, large masks/selections, browser memory failure recovery, and interaction latency remain absent.
- No tests for TIFF/TIF dialog mismatch, native-open file-size limits, or unsupported/malformed raster import feedback.
- Gradient/fill engine tests cover interpolation, radial and multi-stop behavior, opacity/blending, selection coverage, contiguous/global/tolerance behavior, alpha, antialiasing, mask targeting, dimension validation, undo-state helpers, and raster project round-tripping. They do not exercise React pointer handling, toolbar/options behavior, real canvas rendering, or Electron packaging workflows.
- Clone/healing engine tests cover source offsets and alignment mapping, cached overlap sampling, brush spacing, hardness/opacity/flow/pressure, selection coverage, transparent/out-of-bounds samples, local-mean healing, mask alpha, history undo/redo, and native project save/reopen. They do not exercise React pointer handling, merged-composite tile caching, real canvas rendering, or Electron packaging workflows.
- No tests for color profiles, non-PNG export, spot healing, liquify, accessibility, or plugin/automation behavior.
- The shared dev-server page was unavailable during this audit; only the built UI was inspected read-only. Manual interaction behavior remains unverified.

## Recommended development roadmap

Estimates are relative scope only: **Small** is a contained fix; **Medium** touches several application layers; **Large** is a cross-cutting subsystem.

| Priority | Milestone | Size | Why / dependencies |
|---|---|---|---|
| 1 | Repair history correctness and add editor-level undo/dirty-state regression tests — **completed** | **Small–Medium** | History cursor rebasing, saved-state identity, document isolation, and focused regression coverage were added in the History Reliability follow-up. |
| 2 | Establish document memory budgets and responsive rendering safeguards — **initial safeguards completed** | **Large** | Dimension/pixel/allocation preflight, safe failure paths, bounded caches/history, and conservative dirty-region redraw are implemented. Continue with real-renderer stress measurement and worker/tiled rendering before claiming broad large-document performance. |
| 3 | Unify image import/export formats and native-open failure handling | **Medium** | Make dialog filters match actual decoders, apply consistent file-size/resource limits, and add explicit import failure handling. Expand export formats only with deliberate alpha/profile semantics and round-trip tests. |
| 4 | Expand retouching and reduce large-document fill memory/latency | **Large** | Clone and local-mean healing are available, but spot healing and other retouch tools remain absent. Add renderer-level interaction coverage and stress-test fill/retouch latency before promising responsiveness. |
| 5 | Add color management and output fidelity | **Large** | Define profile-aware document and export behavior before adding profile conversion, proofing, or print-oriented output. Depends on a stable import/export pipeline from milestone 3. |
| 6 | Build full vector path and transform editing | **Large** | Extend current straight-segment paths with nodes/curves and editing handles; add arbitrary layer transforms/warp only with clear raster/vector and undo semantics. |
| 7 | Add UI/Electron integration test harness and accessibility/manual acceptance checklist | **Medium** | Cover native dialogs, save failures, close prompts, per-document state, tool interactions, and renderer behavior. This should begin alongside milestones 1–3 and expand as new tools land. |
| 8 | Add documented extension and automation interfaces | **Large** | Defer until document, rendering, history, file, and security APIs are stable; define permissions and compatibility boundaries before exposing plugins or scripting. |

### Recommended sequencing

The practical dependency chain is: **history and document-state integrity → memory/resource safeguards → import/export consistency → new pixel tools → color-managed output**. The first two foundations now have follow-up implementations; prioritize import-format consistency and real-renderer integration/stress tests next. Vector node editing can proceed after its path-data contract is specified, using the repaired history and persistence foundations. E2E testing remains cross-cutting.

## Audit outcome

Only the requested audit document was created. No application source, configuration, tests, dependencies, backups, release folders, installers, or Git state were changed.

## History Reliability follow-up — 2026-11-15

The history cursor and saved-state concerns described above were addressed in a follow-up milestone:

- History trimming now keeps a window around the current cursor, prioritizing undo history while retaining redo entries when capacity allows. It preserves the current state instead of blindly keeping the newest entries.
- A base-state identity is retained when old entries are trimmed, so undoing to the retained baseline can still compare correctly with a saved checkpoint.
- History cursors are bounded at model boundaries; adding an edit after undo discards the redo branch.
- Dirty-state calculation is shared by history updates and successful saves. History limits and cursors remain document-specific when switching tabs.
- Property gestures are finalized on pointer cancellation, keyboard release, blur, and document switching.
- The regression suite now reports **43 passed, 0 failed**, including coverage for branch edits, history trimming, saved checkpoints, Save As paths, document isolation, snapshot fields, grouped changes, invalid operations, and clean project reopen.
- The TypeScript check, production renderer build, Electron build, and Windows installer packaging succeeded through the documented local C: mirror workflow. The new candidate is `release-candidate-history-reliability-20261115`; the known-good installer hash was unchanged.

No interactive GUI acceptance test was performed. Save-dialog failures and concurrent edit/save timing still lack Electron-level integration tests. Large-document resource usage is now bounded at key allocation boundaries, but real-renderer capacity and responsiveness remain unverified.

## Large-Document Performance & Memory Safety follow-up — 2026-11-15

The initial large-document gaps identified above were addressed with conservative limits and preflight checks:

- Documents are capped at **8,192 pixels per side** and **16,777,216 pixels total** (64 MiB for one RGBA buffer). A project is capped at **256 MiB**, its manifest at **32 MiB**, aggregate decoded raster pixels at **64 million**, and native image imports at **100 MiB**. Project images are dimension-checked before bitmap decoding; malformed or oversized assets are rejected before document insertion.
- Selection references are limited to **4,096 tiles per document**. History storage is limited to **128 MiB per document** while retaining the current state and a usable cursor. Isolated render surfaces are limited to **16 MiB each / 64 MiB total**, and mask-alpha caching to **32 MiB**.
- Canvas/RGBA allocation helpers reject unsafe dimensions and byte counts. New-document, image import, resize/crop, mask creation, layer creation/duplication, and selection paste paths report allocation errors without committing partial document state. Native image/project reads have byte caps.
- Simple, untransformed, full-size source-over pixel stacks without masks or effects can composite dirty regions. Other stacks retain the conservative full-render path. Cached surfaces are invalidated by source identity/subtree changes and are pruned to the active document.
- `npm test`: **50 passed, 0 failed** after the final code changes. The production TypeScript check, Vite renderer build, Electron build, and Windows NSIS packaging succeeded through the documented C: mirror.
- A prior 1,024 × 1,024 three-effect benchmark recorded a **53.1 ms baseline median** and **61.07 ms after the effect-stack allocation change**; this is noisy and does **not** demonstrate a timing improvement. The code removes one initial 4 MiB pixel-buffer copy per such effect-stack call, but a broader rendering benchmark was not run.
- Final candidate installer: `release-candidate-large-document-final-20261115-133130\PixelForge Studio Setup 1.0.0.exe` (90,398,882 bytes). Its 95,382-byte gzip-compressed JSON blockmap was decompressed and validated; the packaged `app.asar` contains the dimension-safety code. The known-good installer checksum remained `4E06C5B0043C651632BCCAF9F62C212316C41E18FBBDC70E7E6AC0FA3146162B`. No interactive GUI or large-document stress test was performed, and no build processes remained after packaging.

Remaining risks include aggregate memory across many layers and browser-owned canvas storage, full-canvas processing for complex layer stacks, no worker/offscreen renderer, and a mismatch between TIFF/TIF dialog filters and supported image decoders. These limits reduce unsafe requests but do not guarantee successful allocation under memory pressure.
