# Native PixelForge Studio project format

PixelForge Studio uses the `.pforge` extension for editable native projects. Version 1 stores a document manifest and a binary asset payload in one file. The format is intended for PixelForge Studio and does not claim PSD compatibility.

## Container layout

All integers are unsigned little-endian.

| Offset | Length | Value |
| --- | ---: | --- |
| 0 | 8 | ASCII signature `PFGPROJ` followed by NUL (`50 46 47 50 52 4f 4a 00`) |
| 8 | 4 | UTF-8 manifest byte length |
| 12 | variable | UTF-8 JSON manifest |
| after manifest | variable | Binary assets concatenated in manifest order |

The manifest contains `format: "PixelForge Studio Project"`, `version: 1`, a `document` object and an `assets` array. Each asset entry has a unique `id`, a contiguous `offset` and `length` relative to the start of the binary payload, a lowercase SHA-256 digest, and a supported `mimeType`.

Version 1 asset types are:

- `image/png`: complete pixel-layer canvases and layer masks. Each asset is independently encoded, so layers remain editable and are not flattened.
- `application/x-pforge-selection-tile`: a 128 × 128 selection-mask tile represented by 16,384 raw alpha bytes.

The document object preserves canvas dimensions, resolution, transparency, background, zoom, document-level preview adjustments, ordered layer records, active/selected layer IDs, current and previous selections, and layer properties. Layer records retain IDs, hierarchy, visibility, locking, opacity, blend mode, legacy filter, editable effect stacks, geometry, rotation, flips, editable text/shape data, and optional mask image assets. An `adjustment` layer stores its ordered effects without raster pixels and applies them to the composite beneath it; effect parameters and enabled states remain editable. Missing `effects` properties in older version-1 files load as empty stacks. Unsupported effect kinds, malformed parameters, duplicate effect IDs, and out-of-range values are rejected. New masks use alpha coverage with white RGB; optional `maskEnabled` defaults to enabled for older projects that contain a mask. Legacy mask images without `maskMode: "alpha"` are interpreted as grayscale coverage and normalized during load. Optional `paths` and `activePathId` properties preserve named, visible vector paths as subpaths of document-space points; older version-1 projects without these properties load with an empty Paths panel. The current Paths panel supports stored straight-segment outlines and conversion from selections or vector shapes; Bézier node creation and editing are not implemented. Channel preview choice is a per-tab viewing preference and is not saved. History snapshots are not persisted; reopening begins a fresh undo history at the saved state.

## Validation and limits

The Electron main process owns native file dialogs and disk reads/writes. The sandboxed renderer receives only the validated manifest and typed asset bytes through explicitly exposed preload methods. The reader checks the signature, format/version, manifest and asset bounds, contiguous ranges, supported MIME types and every SHA-256 digest before the renderer decodes a project. The renderer then validates document and layer structure, hierarchy, IDs, geometry, selection tiles, paths and vector properties before adding it as a new tab. Failed opens leave existing documents intact.

The current implementation limits files to 1 GiB, manifests to 32 MiB, canvas edges to 30,000 pixels, layers and paths to 10,000 each, and assets to 100,000. Path records are validated for unique IDs, names, visibility, point coordinates, and a 200,000-point total. Save writes a temporary file beside the destination, flushes it, then renames it into place. Unknown JSON properties are ignored so optional manifest additions can be tolerated. A reader encountering a newer required version fails with an explicit unsupported-version error.

## Versioning and migration

Version 1 is the initial native format. There are no earlier `.pforge` versions to migrate. Any future incompatible schema change must increment `version` and provide an explicit migration before the version is accepted. Never silently interpret an unknown version as version 1.

Adjustment layers support the Normal, Multiply, Screen, Overlay, Darken, Lighten, Color Dodge and Soft Light blend modes. These blend modes preserve the underlying composite's alpha; layer opacity and enabled alpha masks control the adjustment contribution.
