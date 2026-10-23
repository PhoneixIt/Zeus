# AIOS terminal containment: run ONE command inside a Windows Job Object with
# KILL_ON_JOB_CLOSE, so that nothing the command starts can outlive this wrapper.
#
# Protocol
#   stdin : one JSON object {"exe":"...","args":"...","cwd":"...","timeoutMs":120000}
#           `args` is a pre-built CreateProcess argument STRING (already quoted).
#   stdout: one JSON object {"code":0,"out":"...","err":"...","timedOut":false}
#   exit 0: the JSON above was written. exit 1: containment could not be established;
#           the command was NOT run (see stderr for the reason).
#
# Why a Job Object: a plain child-process kill only reaches the process Node spawned.
# A command that starts its own children (node -e "spawn(...)", npm, cmd shims) leaves
# those running, which is exactly how orphaned processes accumulate after a mission.
# With KILL_ON_JOB_CLOSE, closing this wrapper's job handle kills every process still in
# the job - including descendants Node never saw - whether we close it deliberately or
# the wrapper itself is killed.
#
# Failure policy is FAIL-CLOSED: if the job cannot be created or the process cannot be
# assigned to it, this script exits 1 without running the command. There is no fallback
# that runs the command uncontained, because an uncontained run is the defect.
#
# Pure ASCII in this file on purpose: Windows PowerShell 5.1 reads .ps1 files as ANSI
# unless they carry a BOM, and non-ASCII bytes in the C# source below would corrupt.
$ErrorActionPreference = 'Stop'
try {
  [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false
  $spec = [Console]::In.ReadToEnd() | ConvertFrom-Json

  $src = @'
using System;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;

public static class JobRunner
{
    [StructLayout(LayoutKind.Sequential)]
    public struct IO_COUNTERS
    {
        public ulong ReadOperationCount;
        public ulong WriteOperationCount;
        public ulong OtherOperationCount;
        public ulong ReadTransferCount;
        public ulong WriteTransferCount;
        public ulong OtherTransferCount;
    }

    // Layout mirrors winnt.h exactly. The previous shape inlined the basic fields and omitted
    // IoInfo and the four memory fields, so Marshal.SizeOf returned 64 instead of 144 (x64) and
    // SetInformationJobObject rejected it with ERROR_INVALID_PARAMETER (24). Job-object structs
    // are one of the few places where "close enough" is rejected outright - measured, not guessed.
    [StructLayout(LayoutKind.Sequential)]
    public struct JOBOBJECT_BASIC_LIMIT_INFORMATION
    {
        public long PerProcessUserTimeLimit;
        public long PerJobUserTimeLimit;
        public uint LimitFlags;
        public UIntPtr MinimumWorkingSetSize;
        public UIntPtr MaximumWorkingSetSize;
        public uint ActiveProcessLimit;
        public UIntPtr Affinity;
        public uint PriorityClass;
        public uint SchedulingClass;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct JOBOBJECT_EXTENDED_LIMIT_INFORMATION
    {
        public JOBOBJECT_BASIC_LIMIT_INFORMATION BasicLimitInformation;
        public IO_COUNTERS IoInfo;
        public UIntPtr ProcessMemoryLimit;
        public UIntPtr JobMemoryLimit;
        public UIntPtr PeakProcessMemoryUsed;
        public UIntPtr PeakJobMemoryUsed;
    }

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern IntPtr CreateJobObjectW(IntPtr lpJobAttributes, string lpName);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool SetInformationJobObject(IntPtr hJob, int jobObjectInformationClass, ref JOBOBJECT_EXTENDED_LIMIT_INFORMATION lpJobObjectInfo, int cbJobObjectInfoLength);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool AssignProcessToJobObject(IntPtr hJob, IntPtr hProcess);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool CloseHandle(IntPtr hObject);

    private const int JobObjectExtendedLimitInformation = 9;
    private const uint JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x2000;
    private const int CAP = 2 * 1024 * 1024; // per-stream byte cap; beyond it the tail is dropped

    // Returns the decimal exit code of the process, or the literal "timeout" when the
    // timeout elapsed and the process was killed. Throws when the containment boundary
    // itself could not be established; the caller exits 1 and the command never runs.
    public static string Run(string exe, string args, string cwd, int timeoutMs, StringBuilder so, StringBuilder se)
    {
        IntPtr job = CreateJobObjectW(IntPtr.Zero, null);
        if (job == IntPtr.Zero)
            throw new Exception("CreateJobObjectW failed: win32=" + Marshal.GetLastWin32Error());
        try
        {
            JOBOBJECT_EXTENDED_LIMIT_INFORMATION info = new JOBOBJECT_EXTENDED_LIMIT_INFORMATION();
            info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            if (!SetInformationJobObject(job, JobObjectExtendedLimitInformation, ref info, Marshal.SizeOf(typeof(JOBOBJECT_EXTENDED_LIMIT_INFORMATION))))
                throw new Exception("SetInformationJobObject failed: win32=" + Marshal.GetLastWin32Error());

            ProcessStartInfo psi = new ProcessStartInfo();
            psi.FileName = exe;
            psi.Arguments = args;
            psi.WorkingDirectory = cwd;
            psi.UseShellExecute = false;
            psi.CreateNoWindow = true;
            psi.RedirectStandardOutput = true;
            psi.RedirectStandardError = true;
            psi.StandardOutputEncoding = Encoding.UTF8;
            psi.StandardErrorEncoding = Encoding.UTF8;

            object gate = new object();
            bool outCapped = false;
            bool errCapped = false;

            using (Process p = new Process())
            {
                p.StartInfo = psi;
                p.OutputDataReceived += delegate(object s, DataReceivedEventArgs e)
                {
                    if (e.Data == null) return;
                    lock (gate)
                    {
                        if (outCapped) return;
                        int room = CAP - so.Length;
                        if (room <= 0) { outCapped = true; return; }
                        so.Append(e.Data.Substring(0, Math.Min(e.Data.Length, room)));
                        so.Append(Environment.NewLine);
                        if (e.Data.Length >= room) outCapped = true;
                    }
                };
                p.ErrorDataReceived += delegate(object s, DataReceivedEventArgs e)
                {
                    if (e.Data == null) return;
                    lock (gate)
                    {
                        if (errCapped) return;
                        int room = CAP - se.Length;
                        if (room <= 0) { errCapped = true; return; }
                        se.Append(e.Data.Substring(0, Math.Min(e.Data.Length, room)));
                        se.Append(Environment.NewLine);
                        if (e.Data.Length >= room) errCapped = true;
                    }
                };

                try
                {
                    if (!p.Start())
                    {
                        lock (gate) se.Append("could not start ").Append(exe).Append(Environment.NewLine);
                        return "1";
                    }
                }
                catch (Exception ex)
                {
                    // A command that cannot start is a normal outcome, not a containment
                    // failure: the boundary was established fine, the exe was just absent.
                    lock (gate) se.Append("could not start ").Append(exe).Append(": ").Append(ex.Message).Append(Environment.NewLine);
                    return "1";
                }

                // Assign BEFORE any output reads: a process that escapes the job while its
                // grandchildren are already being spawned is exactly the window this order closes.
                if (!AssignProcessToJobObject(job, p.Handle))
                {
                    int win32 = Marshal.GetLastWin32Error();
                    try { p.Kill(); } catch { }
                    throw new Exception("AssignProcessToJobObject failed: win32=" + win32);
                }

                p.BeginOutputReadLine();
                p.BeginErrorReadLine();

                bool exited = p.WaitForExit(timeoutMs);
                if (!exited)
                {
                    try { p.Kill(); } catch { }
                    try { p.WaitForExit(5000); } catch { }
                    return "timeout";
                }
                // Parameterless WaitForExit: waits for the async readers to drain, so the
                // StringBuilders are complete before the caller serialises them.
                p.WaitForExit();
                return p.ExitCode.ToString();
            }
        }
        finally
        {
            // Closing the job kills every surviving process in it - the root included.
            // This runs on every path, deliberate or not.
            CloseHandle(job);
        }
    }
}
'@
  Add-Type -TypeDefinition $src -Language CSharp -ErrorAction Stop

  $so = New-Object System.Text.StringBuilder
  $se = New-Object System.Text.StringBuilder
  $codeText = [JobRunner]::Run(
    [string]$spec.exe, [string]$spec.args, [string]$spec.cwd, [int]$spec.timeoutMs, $so, $se)

  $timedOut = ($codeText -eq 'timeout')
  $code = if ($timedOut) { -1 } else { [int]$codeText }
  if ($timedOut) {
    [void]$se.Append("[timed out after ").Append([int]$spec.timeoutMs).Append("ms; the process tree was killed]").Append([Environment]::NewLine)
  }

  $result = @{
    code = $code
    out = $so.ToString()
    err = $se.ToString()
    timedOut = $timedOut
  }
  [Console]::Out.WriteLine((ConvertTo-Json -InputObject $result -Compress -Depth 4))
  exit 0
}
catch {
  # Containment could not be established (or the wrapper itself faulted). Say why and
  # exit 1 WITHOUT running anything: the caller reports the command as not run.
  [Console]::Error.WriteLine("job-exec: " + $_.Exception.Message)
  exit 1
}
