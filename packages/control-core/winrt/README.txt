VENDORED WINRT METADATA - why this directory exists
==================================================
These two files come from the NuGet package Microsoft.Windows.SDK.Contracts
(version 10.0.28000.2705), and they are the ONLY reason OCR can be built at all on
this machine.

THE PROBLEM THEY SOLVE
----------------------
Windows.Media.Ocr lives in the WinRT projection. The .NET Framework compiler
rejects WinRT code unless it can see an assembly named Windows, version
255.255.255.255, ContentType=WindowsRuntime - that is Windows.winmd, shipped by
the Windows SDK under C:\Program Files (x86)\Windows Kits\10\UnionMetadata\,
which is EMPTY on this machine and which no Windows.winmd exists anywhere else to
replace. Seven attempts to build OCR failed on exactly that missing reference.

WHY THESE FILES AND NOT THE SDK
-------------------------------
Windows.Foundation.UniversalApiContract.winmd CONTAINS Windows.Media.Ocr.OcrEngine
- verified, not assumed - and it compiles against the .NET Framework compiler with
no SDK installed at all. That is ~3.7 MB downloaded and two files kept, instead of a
multi-gigabyte SDK installation, and it needs no administrative change to the
machine.

To obtain them again:
  https://api.nuget.org/v3-flatcontainer/microsoft.windows.sdk.contracts/10.0.28000.2705/
    microsoft.windows.sdk.contracts.10.0.28000.2705.nupkg
then copy ref/netstandard2.0/Windows.Foundation.{UniversalApiContract,FoundationContract}.winmd here.

NOTE ON AsTask
--------------
Neither the Windows SDK facade nor System.Runtime.WindowsRuntime's AsTask extension
is needed. AsTask's signature mentions Windows.Foundation.IAsyncOperation<T> from
the missing Windows assembly, which is what broke every earlier attempt. The
projected IAsyncOperation<T> also exposes Status and GetResults() directly, so a
bounded poll reaches the same result. See Ocr.cs.
