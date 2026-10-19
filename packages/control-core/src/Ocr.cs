// ===========================================================================================
// OCR - read the text that is actually ON the screen, including text that no control exposes.
//
// WHY THIS IS C# AND NOT POWERSHELL
//
// Attempted in PowerShell first and failed seven ways, each with an error naming something other
// than the cause: a null engine, a PSObject where a String was expected, "no method named
// GetAwaiter", "cannot find an overload for AsTask", "not a GenericMethodDefinition", "Value
// cannot be null", and finally `Add-Type` refusing outright with "The type or namespace name
// 'Media' does not exist in the namespace 'Windows'". PowerShell 5.1 cannot await a WinRT
// operation, and resolving the right generic AsTask overload by reflection needs to know which of
// four IAsyncOperation shapes .NET returned - which is guesswork.
//
// C# can express the operation directly. That is the whole reason this file is C# rather than a
// script. See docs/OCR-HANDOVER.md for the full failure record.
//
// WHY THIS DOES NOT USE AsTask
//
// Because AsTask is the thing that dragged in the reference this machine does not have. Its
// signature mentions `Windows.Foundation.IAsyncOperation<T>` belonging to assembly `Windows`,
// version 255.255.255.255 - the Windows SDK facade `Windows.winmd`, absent here. Every attempt
// that used AsTask, or `await` (which needs the same awaiter), died on that missing assembly.
//
// The PROJECTED IAsyncOperation<T> also exposes `Status` and `GetResults()` directly. So this
// polls to completion and reads the result, with a deadline. That is the same operation reached
// by a different route, and it compiles with nothing but the vendored contract metadata in
// packages/control-core/winrt - no SDK, no facade, no awaiter.
//
// WHY THIS IS A SEPARATE SOURCE FILE
//
// Guard.cs and Hooks.cs are deliberately separate from OperatorHost.cs so the safety layer
// cannot be edited by the automation layer it constrains. This file is the same shape and for a
// related reason: it READS the screen and nothing else. It injects nothing, calls no SendInput,
// and never touches the guard - because a component that can see what the user typed must not
// also be able to move the cursor.
// ===========================================================================================
using System;
using System.Collections.Generic;
using System.IO;
using System.Threading;
using Windows.Foundation;
using Windows.Globalization;
using Windows.Graphics.Imaging;
using Windows.Media.Ocr;
using Windows.Storage;
using Windows.Storage.Streams;

namespace PortAiOperator
{
    /// One recognised line of text, with its position in the host's virtualized input space.
    public sealed class OcrLine
    {
        public string Text;
        public int X, Y, W, H;
    }

    /// The result of reading a region: the text, the lines, and whether it worked at all.
    public sealed class OcrOutcome
    {
        public bool Ok;
        public string Error = "";
        public string Text = "";
        public string Language = "";
        public List<OcrLine> Lines = new List<OcrLine>();
    }

    public static class Ocr
    {
        static int ToVirt(int phys, int virtSpan, int physSpan)
        {
            if (physSpan <= 0) return phys;
            return (int)Math.Round((double)phys * virtSpan / physSpan);
        }

        /// Wait for a WinRT operation, then take its result.
        ///
        /// The poll is bounded and the failure is specific. An unbounded wait on a call that will
        /// never complete would hang a request thread in a long-lived host, which serves the guard
        /// as well as the interface - one stuck OCR request would take the whole operator down
        /// with it.
        static T Await<T>(IAsyncOperation<T> op, string what, int timeoutMs)
        {
            int waited = 0;
            while (op.Status == AsyncStatus.Started && waited < timeoutMs)
            {
                Thread.Sleep(20);
                waited += 20;
            }
            if (op.Status == AsyncStatus.Started) throw new Exception(what + " did not complete within " + timeoutMs + "ms");
            if (op.Status == AsyncStatus.Canceled) throw new Exception(what + " was cancelled by the system");
            if (op.Status == AsyncStatus.Error) throw new Exception(what + " failed: " + op.ErrorCode);
            return op.GetResults();
        }

        /// Read a PNG from disk and return everything OCR found in it.
        ///
        /// The PNG goes through the WinRT BitmapDecoder rather than being handed to OCR as raw
        /// pixels, because SoftwareBitmap demands a pixel-buffer layout that is easy to get
        /// subtly wrong and impossible to debug from a JSON error.
        static OcrOutcome ReadFile(string png, int physX, int physY,
                                   int virtW, int virtH, int physW, int physH)
        {
            var outcome = new OcrOutcome();
            IRandomAccessStream stream = null;
            try
            {
                var file = Await(StorageFile.GetFileFromPathAsync(png), "opening the capture", 10000);
                stream = Await(file.OpenAsync(FileAccessMode.Read), "reading the capture", 10000);
                var decoder = Await(BitmapDecoder.CreateAsync(stream), "decoding the capture", 10000);
                var bitmap = Await(decoder.GetSoftwareBitmapAsync(), "converting the capture", 10000);

                // en-US by name first, then whatever the user's profile languages say. A bare "en"
                // was the first attempt and returns null on machines without that exact tag.
                var engine = OcrEngine.TryCreateFromLanguage(new Language("en-US"));
                if (engine == null) engine = OcrEngine.TryCreateFromUserProfileLanguages();
                if (engine == null)
                {
                    outcome.Error = "no OCR engine could be created for this machine, which means no "
                                  + "language pack matching en-US or the user's profile is installed";
                    return outcome;
                }
                outcome.Language = engine.RecognizerLanguage.LanguageTag;

                // The engine refuses images beyond its own limit, and reports the limit itself
                // rather than having it guessed here. It is a STATIC member - an instance access
                // compiles to CS0176, which is the compiler being precise about the API rather
                // than about this code.
                if (bitmap.PixelWidth > OcrEngine.MaxImageDimension || bitmap.PixelHeight > OcrEngine.MaxImageDimension)
                {
                    outcome.Error = "the captured region is " + bitmap.PixelWidth + "x" + bitmap.PixelHeight
                                  + " but this OCR engine accepts at most " + OcrEngine.MaxImageDimension
                                  + " pixels per side. Capture a smaller region.";
                    return outcome;
                }

                var result = Await(engine.RecognizeAsync(bitmap), "recognising text", 30000);
                var joined = new List<string>();
                foreach (var line in result.Lines)
                {
                    if (string.IsNullOrWhiteSpace(line.Text)) continue;
                    if (line.Words.Count == 0) continue;
                    // The FIRST word's box, not the line's: the line's BoundingRect is only
                    // populated on some builds, and an empty box would place every line at 0,0
                    // with no size - a coordinate that looks valid and is useless.
                    var r = line.Words[0].BoundingRect;
                    joined.Add(line.Text);
                    outcome.Lines.Add(new OcrLine
                    {
                        Text = line.Text,
                        X = ToVirt((int)(physX + r.X), virtW, physW),
                        Y = ToVirt((int)(physY + r.Y), virtH, physH),
                        W = ToVirt((int)r.Width, virtW, physW),
                        H = ToVirt((int)r.Height, virtH, physH),
                    });
                }
                outcome.Text = string.Join("\n", joined.ToArray());
                outcome.Ok = true;
                return outcome;
            }
            finally
            {
                if (stream != null) stream.Dispose();
            }
        }

        /// Reads a region and returns the text, or a plain failure the caller can report.
        public static OcrOutcome Read(string png, int physX, int physY,
                                      int virtW, int virtH, int physW, int physH)
        {
            try
            {
                return ReadFile(png, physX, physY, virtW, virtH, physW, physH);
            }
            catch (Exception e)
            {
                // An OCR failure is a READ failure and never a reason to crash the host, which is a
                // long-lived process that serves the guard as well as the interface.
                return new OcrOutcome { Ok = false, Error = e.Message };
            }
        }
    }
}