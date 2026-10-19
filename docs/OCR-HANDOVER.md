# OCR - WORKING. This document is a record of how it was blocked, and how it was not.

**Date:** 2026-10-16
**Status:** `/ocr` is live on the operator host, backed by the OCR engine built into Windows.

Verified on this machine: `GET /ocr?x=0&y=0&w=700&h=400` returned `ok:true`, `language=en-US`,
14 recognised lines with bounding boxes. The capability layer reads it too
(`capabilities.ts` → `ocrTool` / `ocrVerifier`).

---

## Why it was blocked for so long

The blocker was never "OCR is hard". It was one missing file, and the missing file was never the
one being looked for.

The .NET Framework compiler rejects WinRT code unless it can see an assembly named `Windows`,
version 255.255.255.255, `ContentType=WindowsRuntime`. That is `Windows.winmd`, shipped by the
Windows SDK under `C:\Program Files (x86)\Windows Kits\10\UnionMetadata\` — a directory that is
**empty on this machine**, with no copy anywhere else on the system. Every attempt failed on that
one reference, and the error named `Windows.Foundation.winmd`, which is a different file that does
exist.

Seven failed approaches are recorded in the git history of `docs/OCR-HANDOVER.md` at commit
`2abc2f6`. They failed in PowerShell for a separate and equally real reason: **PowerShell 5.1
cannot await a WinRT operation.** So two independent walls stood between this machine and OCR.

## What actually solved it

**1. The Windows SDK was not needed at all.**

`Windows.Foundation.UniversalApiContract.winmd` — from the NuGet package
`Microsoft.Windows.SDK.Contracts` (3.7 MB) — **contains `Windows.Media.Ocr.OcrEngine`**, and
`csc.exe` compiles against it with no SDK installed. Verified by inspection *and* by compiling:
the package declares the assembly as `Windows.Foundation.UniversalApiContract`, not `Windows`,
and it works anyway.

Two files, ~6 MB, vendored in `packages/control-core/winrt/`. No multi-gigabyte SDK, no
administrative change to the machine. See `winrt/README.txt` for how to re-obtain them.

**2. `AsTask` was the thing pulling in the missing assembly.**

`AsTask`'s signature mentions `Windows.Foundation.IAsyncOperation<T>` from the absent `Windows`
assembly. `await` needs the same awaiter. Both were removed.

The **projected** `IAsyncOperation<T>` also exposes `Status` and `GetResults()` directly, so a
bounded poll reaches the identical result. That is all `Ocr.Await` does, and it is why this
compiles here at all.

**3. PowerShell's `Add-Type` could not build the host any more.**

With the winmd in play, `Add-Type` refused:

```
Add-Type : Could not load file or assembly '...\Windows.Foundation.UniversalApiContract.winmd'
or one of its dependencies. The given assembly name or codebase was invalid. (0x80131047)
```

It loads every `-ReferencedAssemblies` entry as a *managed* assembly; WinRT metadata is not one.
The host is therefore now **compiled by `csc` into `PortAiOperator.dll` and loaded by PowerShell**,
rather than compiled in-memory. This is an improvement in its own right: build failures now arrive
as line-numbered compiler errors at build time instead of as an exception on the first request.

## Honest limits

- **OCR can misread.** It is a fallback for applications that draw text as pixels. The
  accessibility tree is exact and is tried first; `survey-window` should be preferred wherever it
  has anything to say, and the capability description says so.
- **A partial reading is not proof text is absent.** Stated in the capability description, because
  the failure it prevents is concluding "there is no text here" from an instrument that merely
  could not see it.
- **Region size is capped** by the engine (`MaxImageDimension`, reported by the host itself rather
  than guessed). A full 8K screen capture would need tiling, which is not implemented.

## Cost

$0. No API, no key, no subscription, no download at run time. The OCR engine is part of Windows.