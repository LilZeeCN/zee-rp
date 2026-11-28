# Axure RP Binary Format Interoperability Specification (`.rp` / `.rplib`, RP 9 & RP 11)

> **Scope & Intent**: Clean-room interoperability documentation derived from empirical inspection of local Axure RP 9 (`9.0.0.3754`) and RP 11 (`11.0.0.4137`) files and verified reference implementations in [`scripts/rp-records.mjs`](../scripts/rp-records.mjs), [`scripts/parse-payload.mjs`](../scripts/parse-payload.mjs), [`scripts/blank-synthesizer.mjs`](../scripts/blank-synthesizer.mjs), [`scripts/version-fields.mjs`](../scripts/version-fields.mjs), and [`scripts/build-library.mjs`](../scripts/build-library.mjs). Zero-dependency browser parsing, diffing, repair, downgrade, and `.rplib` serialization are implemented isomorphically in [`scripts/rp-browser-core.mjs`](../scripts/rp-browser-core.mjs).

---

## 1. Outer Container Framing (`.rp` and Synthesized `.rplib`)

Every `.rp` file (and modern container-wrapped `.rplib` compiled by [`build-library.mjs`](../scripts/build-library.mjs)) uses a framing layout headed by an 8-byte signature and an LZ4-compressed JSON manifest:

```text
Offset   Size   Field
0x00     2      Magic: 0xAC 0xEF
0x02     2      u16 LE FileVersion: 9 (0x0009) or 11 (0x000B)
0x04     4      u32 LE manifestLength (compressed manifest extent in bytes; dataStart = 8 + manifestLength)
0x08     ...    Manifest payload (see §1.1)
dataStart ...   Sequence of record chunks: [4B u32 zero][4B u32 LE compressedSize][gzip bytes]
```

> **Note on bare `.rplib` streams**: Legacy bare widget libraries exist without an `AC EF` header and begin directly with `[4B prefix][gzip record]` at offset 0. Both [`rp-records.mjs`](../scripts/rp-records.mjs) and [`rp-browser-core.mjs`](../scripts/rp-browser-core.mjs) read both forms, while [`build-library.mjs`](../scripts/build-library.mjs) emits standard `AC EF` containers with `DesignDocument` `document-type = 2`, `SavedEdition = 2`, `DocumentSettings`, and `*.version` manifest parts.

### 1.1 LZ4 Block Manifest (`offset 0x08 .. dataStart`)

```text
Byte 0x08:     0x01 (version/mode flag)
Next:          varuint uncompressedLength (7-bit LEB128)
Next:          varuint lz4BlockLength
Next:          raw LZ4 block bytes (token + literal length + literals + u16 LE offset + match length)
```

**Critical serializer constraint (K4os.Compression.LZ4 interoperability)**:
Axure's loader decodes the manifest via `K4os.Compression.LZ4` segmented stream reader and rejects pure-literal (zero-match) LZ4 blocks with `EndOfStreamException` (`AcquireNextChunk`). Real manifests always compress smaller than their UTF-8 JSON length via ≥1 LZ4 back-reference match; writers must enforce `block.length < raw.length`.

### 1.2 Manifest JSON Structure

The decompressed manifest JSON holds a tree rooted at `root`:

```json
{
  "root": {
    "parts": {
      "DesignDocument": 12345,
      "DocumentSettings": 23456,
      "9.0.0.3754.version": 34567
    },
    "children": {
      "<guidKey(pageGuid)>": {
        "parts": { "thumbnail": 0, "package": 128 },
        "children": {
          "<guidKey(panelStateGuid)>": { "parts": { "package": 512 } }
        }
      }
    }
  }
}
```

- All offsets in `parts` are **relative to `dataStart`**, pointing to the 8-byte chunk header `[4B zero][4B compressedSize]` immediately preceding each gzip payload (i.e. `absoluteGzipOffset = dataStart + relOffset + 8`).
- `guidKey(hex)` swaps the first three fields of a 16-byte record GUID into standard Microsoft `Guid` byte-order hex (`4B LE / 2B LE / 2B LE / 8B BE`) and vice-versa via `unguidKey(hex)`.

---

## 2. Record Framing & String Table

Decompressing a gzip record chunk yields either:

1. **XML Sidecar Record** (e.g., `<BreakingChanges>...</BreakingChanges>` mapped to the `*.version` manifest part, identified synthetically as `xml:BreakingChanges`).
2. **Binary Object Record** with a 32-byte header and UTF-8 string table:

```text
0x00 (4B):  u32 LE headerConstant (0x0000001B in blank/synthesized records)
0x04 (4B):  u32 LE recordVersion (9 or 11)
0x0C (4B):  u32 LE editionFlag (1 on RP9, 0 on RP11)
0x14 (4B):  u32 LE recordMarker === 0x0000C351
0x18 (4B):  u32 LE formatTag (31 / 0x1F)
0x1C (4B):  u32 LE stringCount
0x20 ... :  stringCount entries of [u32 LE byteLen][UTF-8 bytes]
payload  :  Binary AST stream until EOF
```

- String indices in payload tags `0x08` (string literal) and `0x09` (object class index) are **1-based** (`strings[index - 1]`).
- `strings[0]` (`stringIndex = 1`) is the record's primary root class name (e.g. `Axure:DesignDocument`, `Axure:Page`, `Axure:PanelState`, `Axure:Master`, `Axure:DocumentSettings`).

### 2.1 Ordering Invariant (`PanelState` Before Owner `Page`)

Axure's editor and native deserializers require `Axure:PanelState` records to appear **before** their owning `Axure:Page` (and before `Axure:DesignDocument` / `Axure:DocumentSettings`) in the physical record stream. Appending a new `PanelState` to the tail causes double-click editing failures in GUI mode; [`insertRecord`](../scripts/rp-records.mjs) inserts `PanelState` ahead of its owner `Page` and shifts subsequent `parts` offsets atomically.

---

## 3. Binary Payload Grammar (`Tag 0x01 – 0x1E`)

Values in the binary AST begin with a 32-bit unsigned little-endian `tag` code:

| Tag | Kind | Binary Layout After 4-Byte `tag` |
| --- | --- | --- |
| `0x01` | Dict | `u32 count`, followed by `count` pairs of `[val key, val value]` |
| `0x02` | List | `u32 count`, followed by `count` `val` items |
| `0x03` | Object Ref | `u32 objectId` (references `tag 0x09` object in the same record) |
| `0x04` | Bytes / Blob | `u32 byteLen`, followed by `byteLen` raw bytes |
| `0x05` | Int32 / UInt32 | `u32 value` |
| `0x06` | Float64 (IEEE-754) | `f64 LE` (8 bytes; NaN bit-patterns must be preserved verbatim on roundtrip) |
| `0x08` | String Ref | `u32 stringIndex` (1-based into record's `strings` table) |
| `0x09` | Object Definition | `u32 objectId`, `u32 classIndex` (1-based string), `val body` (always `tag 0x01` Dict) |
| `0x0F` | Root Object Ref | `u32 rootObjectId` (top-level skeleton marker) |
| `0x10` | Typed Ref Pair A | `u32 stringIndex`, `u32 guidIndex` (1-based into `0x1E` GUID table) |
| `0x11` | GUID Ref A | `u32 guidIndex` (1-based into `0x1E`) |
| `0x12` | Package GUID Ref | `u32 guidIndex` (points to owning package GUID slot in `0x1E`) |
| `0x13` | Typed Ref Pair B | `u32 stringIndex`, `u32 guidIndex` (used by `PackageInfo.package-id` and `PanelDiagramInfo.PackageId`) |
| `0x14` | GUID Ref B | `u32 guidIndex` (e.g., `Axure:Page` `start/end-diagram-object`) |
| `0x16` | Owner GUID Ref | `u32 guidIndex` (e.g., `Axure:Annotation.OwnerId`) |
| `0x19` | Boolean | `1 byte` (`0x00` or `0x01`) |
| `0x1A` | Skeleton Header Mark | 0 payload bytes (decimal `26`) |
| `0x1C` | Skeleton Footer Mark | 0 payload bytes (decimal `28`) |
| `0x1D` | Capabilities / Mask | 8 raw bytes (e.g. `ffffffffffffffff`) |
| `0x1E` | GUID Table | `u32 count`, followed by `count × 16 bytes` (128-bit GUID slots, 1-based indexing) |

### 3.1 Top-Level Record Skeleton & Deterministic Unknown-Tag Passthrough

Across inspected records, valid top-level AST sequences obey the invariant:

```text
[0x1E GUID table] [0x1A] [0x0F rootId] [0x12 pkgGuidIdx] [tag 0x09 object ...] [0x1C]
```

where `roots[4].className === strings[0]`, every object's `body.tag === 0x01`, all `0x08` string indices & `0x09` class indices are in bounds, and no Dict key is a container (`0x01`, `0x02`, `0x09`). Unknown tags encountered during `parsePayload` are probed across 7 candidate layouts (`none`, `u8`, `u16`, `u32`, `u64`, `dict`, `list`) and accepted **only** if a unique end-aligned, invariant-satisfying interpretation re-encodes byte-identically ([`scripts/parse-payload.mjs`](../scripts/parse-payload.mjs)).

---

## 4. Identity & Semantic Diff Stability

- **Cross-save persistent identity**: Within a package record, local integer `objectId` slots (`tag 0x09` / `0x03`) can be compacted/reassigned by Axure on save, whereas the 128-bit GUID stored at `guids[objectId - 1]` (or package GUID in `DesignDocument.PackageInfo` & `0x12`) remains stable across saves.
- **Zero-noise semantic diffing** ([`diff-rp.mjs`](../scripts/diff-rp.mjs)): Normalizing interaction AST slot references and geometry/DOA enabled flags to 128-bit GUIDs and global variable names removes save-time slot churn so unchanged GUI re-saves report `0` structural changes.

---

## 5. RP 9 vs RP 11 Version Boundaries (Downgrade & Synthesis Requirements)

To emit or downgrade an `.rp` / `.rplib` without triggering Axure editor upgrade modals or `InvalidDataException` on deserialization:

1. **Manifest Version Part**: `9.0.0.3754.version` (RP 9) vs `11.0.0.4137.version` (RP 11) containing matching `<BreakingChanges>` XML.
2. **`Axure:DocumentSettings`**: `FileVersionHistory` (`9.0.1.0` vs `11.0.0.0`) and `AssemblyVersionHistory` (`9.0.0.3754` vs `11.0.0.4137`), plus dropping RP11-only keys (`FloatingEditorLayoutInfos`, `PrototypeDeleted`, `ShowLastPublishedCurrentLinks`, `UploadedSitmapIds`) when targeting RP 9.
3. **RP 9 Mandatory Dynamic Panel Registry**: Every dynamic panel on RP 9 must register `Axure:DynamicPanelInfo` and `Axure:PanelDiagramInfo` chains inside `Axure:PackageInfo['root-panel-infos']` in `DesignDocument`; omitting this yields an empty panel body in RP 9 ([`fix-panel-registry.mjs`](../scripts/fix-panel-registry.mjs)). Every `Axure:PackageInfo` in RP 9 must carry `root-panel-infos` even when empty (`[]`).
4. **Version-Exclusive Construct Gating** ([`version-fields.mjs`](../scripts/version-fields.mjs) & [`downgrade-rp.mjs`](../scripts/downgrade-rp.mjs)):
   - RP 11 adds required `Error: false` fields on `Layer`, `ImageBox`, and `VectorShape`, adds `Disabled`/`Error`/scale/blur keys across actions & diagram objects, adds DOA codes `0x6c–0x6d` and `0x578–0x57d`, adds `OnErrorSet` / `OnErrorRemoved` / `OnBeforeItemLoad`, adds `Axure:InteractionApplyStyle` / `Axure:InteractionApplyStyleInfo`, and uses integer enum for `EnableDisableWidgetsInfo.enable`.
   - RP 9 requires `FadeWidgetInfo.vertical` and `SetPanelStateInfo.vertical` (`tag 0x19`) and expects `bool` for `EnableDisableWidgetsInfo.enable`.

---

## 6. Native Widget Library Format (`.rplib`)

In `Axure:DesignDocument`:
- `document-type`: `1` (`.rp` prototype) vs **`2`** (`.rplib` widget library)
- `SavedEdition`: `1` (`.rp`) vs **`2`** (`.rplib`)

Each library item appears as a page-like `Axure:Page` entry registered in `sitemap` / `PackageInfos`. [`index-library.mjs`](../scripts/index-library.mjs), [`clone-library-widget.mjs`](../scripts/clone-library-widget.mjs), and [`build-library.mjs`](../scripts/build-library.mjs) operate directly against this representation.
