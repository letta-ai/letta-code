// Copyright 2026 Letta AI
// SPDX-License-Identifier: Apache-2.0

using System;
using System.Collections.Generic;
using System.IO;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
using System.Security.Principal;
using System.Text;

public static class LettaWindowsSandbox
{
    private const uint DISABLE_MAX_PRIVILEGE = 0x00000001;
    private const uint WRITE_RESTRICTED = 0x00000008;
    private const uint TOKEN_ALL_ACCESS = 0x000F01FF;
    private const uint SE_GROUP_ENABLED = 0x00000004;
    private const uint CREATE_SUSPENDED = 0x00000004;
    private const uint CREATE_BREAKAWAY_FROM_JOB = 0x01000000;
    private const uint STARTF_USESTDHANDLES = 0x00000100;
    private const int STD_INPUT_HANDLE = -10;
    private const int STD_OUTPUT_HANDLE = -11;
    private const int STD_ERROR_HANDLE = -12;
    private const int JobObjectExtendedLimitInformation = 9;
    private const uint JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x00002000;
    private const uint JOB_OBJECT_LIMIT_DIE_ON_UNHANDLED_EXCEPTION = 0x00000400;
    private const uint INFINITE = 0xFFFFFFFF;
    private const uint WAIT_FAILED = 0xFFFFFFFF;
    private const uint LOGON_WITH_PROFILE = 0x00000001;

    [StructLayout(LayoutKind.Sequential)]
    private struct SID_AND_ATTRIBUTES
    {
        public IntPtr Sid;
        public uint Attributes;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct JOBOBJECT_BASIC_LIMIT_INFORMATION
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
    private struct IO_COUNTERS
    {
        public ulong ReadOperationCount;
        public ulong WriteOperationCount;
        public ulong OtherOperationCount;
        public ulong ReadTransferCount;
        public ulong WriteTransferCount;
        public ulong OtherTransferCount;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct JOBOBJECT_EXTENDED_LIMIT_INFORMATION
    {
        public JOBOBJECT_BASIC_LIMIT_INFORMATION BasicLimitInformation;
        public IO_COUNTERS IoInfo;
        public UIntPtr ProcessMemoryLimit;
        public UIntPtr JobMemoryLimit;
        public UIntPtr PeakProcessMemoryUsed;
        public UIntPtr PeakJobMemoryUsed;
    }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct STARTUPINFO
    {
        public uint cb;
        public string lpReserved;
        public string lpDesktop;
        public string lpTitle;
        public uint dwX;
        public uint dwY;
        public uint dwXSize;
        public uint dwYSize;
        public uint dwXCountChars;
        public uint dwYCountChars;
        public uint dwFillAttribute;
        public uint dwFlags;
        public short wShowWindow;
        public short cbReserved2;
        public IntPtr lpReserved2;
        public IntPtr hStdInput;
        public IntPtr hStdOutput;
        public IntPtr hStdError;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct PROCESS_INFORMATION
    {
        public IntPtr hProcess;
        public IntPtr hThread;
        public uint dwProcessId;
        public uint dwThreadId;
    }

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern IntPtr GetCurrentProcess();

    [DllImport("advapi32.dll", SetLastError = true)]
    private static extern bool OpenProcessToken(IntPtr processHandle, uint desiredAccess, out IntPtr tokenHandle);

    [DllImport("advapi32.dll", SetLastError = true)]
    private static extern bool CreateRestrictedToken(
        IntPtr existingTokenHandle,
        uint flags,
        uint disableSidCount,
        IntPtr sidsToDisable,
        uint deletePrivilegeCount,
        IntPtr privilegesToDelete,
        uint restrictedSidCount,
        IntPtr sidsToRestrict,
        out IntPtr newTokenHandle);

    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool ConvertStringSidToSid(string stringSid, out IntPtr sid);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern IntPtr LocalFree(IntPtr handle);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool CloseHandle(IntPtr handle);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern IntPtr GetStdHandle(int nStdHandle);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern IntPtr CreateJobObject(IntPtr jobAttributes, string name);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool SetInformationJobObject(IntPtr job, int infoClass, IntPtr info, uint infoLength);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern uint ResumeThread(IntPtr thread);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool GetExitCodeProcess(IntPtr process, out uint exitCode);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool TerminateProcess(IntPtr process, uint exitCode);

    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool CreateProcessAsUser(
        IntPtr token,
        string applicationName,
        string commandLine,
        IntPtr processAttributes,
        IntPtr threadAttributes,
        bool inheritHandles,
        uint creationFlags,
        IntPtr environment,
        string currentDirectory,
        ref STARTUPINFO startupInfo,
        out PROCESS_INFORMATION processInformation);

    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool CreateProcessWithTokenW(
        IntPtr token,
        uint logonFlags,
        string applicationName,
        string commandLine,
        uint creationFlags,
        IntPtr environment,
        string currentDirectory,
        ref STARTUPINFO startupInfo,
        out PROCESS_INFORMATION processInformation);

    private sealed class Options
    {
        public bool RestrictWrites;
        public readonly List<string> DeniedRoots = new List<string>();
        public readonly List<string> BaseWritableRoots = new List<string>();
        public readonly List<string> ReadonlyRoots = new List<string>();
        public readonly List<string> WritableRoots = new List<string>();
        public readonly List<string> Command = new List<string>();
    }

    private sealed class AppliedRule
    {
        public readonly string Path;
        public readonly FileSystemAccessRule Rule;
        public readonly bool IsDirectory;

        public AppliedRule(string path, FileSystemAccessRule rule, bool isDirectory)
        {
            Path = path;
            Rule = rule;
            IsDirectory = isDirectory;
        }
    }

    public static int Main(string[] args)
    {
        Options options;
        try
        {
            options = ParseOptions(args);
        }
        catch (Exception error)
        {
            Console.Error.WriteLine("Letta Windows sandbox: " + error.Message);
            return 2;
        }

        if (options.Command.Count == 0)
        {
            Console.Error.WriteLine("Letta Windows sandbox: missing command after --");
            return 2;
        }

        var appliedRules = new List<AppliedRule>();
        var allocatedSids = new List<IntPtr>();
        IntPtr originalToken = IntPtr.Zero;
        IntPtr restrictedToken = IntPtr.Zero;
        IntPtr restrictedSidArray = IntPtr.Zero;
        IntPtr job = IntPtr.Zero;
        PROCESS_INFORMATION processInfo = new PROCESS_INFORMATION();

        try
        {
            var sandboxSid = new SecurityIdentifier(CreateSandboxSid());

            if (options.RestrictWrites)
            {
                foreach (var root in options.BaseWritableRoots)
                {
                    AddWritableRule(root, sandboxSid, appliedRules);
                }
            }

            foreach (var root in options.DeniedRoots)
            {
                AddRuleIfPathExists(root, sandboxSid, DenyRights(), AccessControlType.Deny, appliedRules);
            }

            foreach (var root in options.ReadonlyRoots)
            {
                AddReadonlyRuleIfPathExists(root, sandboxSid, appliedRules);
            }

            foreach (var root in options.WritableRoots)
            {
                AddWritableRule(root, sandboxSid, appliedRules);
            }

            if (!OpenProcessToken(GetCurrentProcess(), TOKEN_ALL_ACCESS, out originalToken))
            {
                return FailLastError("OpenProcessToken");
            }

            var restrictedSidStrings = new List<string>();
            if (options.RestrictWrites)
            {
                restrictedSidStrings.Add(sandboxSid.Value);
            }
            else
            {
                var user = WindowsIdentity.GetCurrent().User;
                if (user == null)
                {
                    Console.Error.WriteLine("Letta Windows sandbox: could not resolve current user SID");
                    return 1;
                }
                restrictedSidStrings.Add(user.Value);
                restrictedSidStrings.Add(sandboxSid.Value);
            }

            restrictedSidArray = BuildSidAndAttributesArray(restrictedSidStrings, allocatedSids);
            uint tokenFlags = DISABLE_MAX_PRIVILEGE | (options.RestrictWrites ? WRITE_RESTRICTED : 0);
            if (!CreateRestrictedToken(
                originalToken,
                tokenFlags,
                0,
                IntPtr.Zero,
                0,
                IntPtr.Zero,
                (uint)restrictedSidStrings.Count,
                restrictedSidArray,
                out restrictedToken))
            {
                return FailLastError("CreateRestrictedToken");
            }

            job = CreateKillOnCloseJob();
            if (job == IntPtr.Zero)
            {
                return 1;
            }

            if (!StartChild(restrictedToken, job, options.Command, ref processInfo))
            {
                return 1;
            }

            var wait = WaitForSingleObject(processInfo.hProcess, INFINITE);
            if (wait == WAIT_FAILED)
            {
                return FailLastError("WaitForSingleObject");
            }

            uint exitCode;
            if (!GetExitCodeProcess(processInfo.hProcess, out exitCode))
            {
                return FailLastError("GetExitCodeProcess");
            }
            return unchecked((int)exitCode);
        }
        catch (Exception error)
        {
            Console.Error.WriteLine("Letta Windows sandbox: " + error.Message);
            return 1;
        }
        finally
        {
            if (processInfo.hThread != IntPtr.Zero) CloseHandle(processInfo.hThread);
            if (processInfo.hProcess != IntPtr.Zero) CloseHandle(processInfo.hProcess);
            if (job != IntPtr.Zero) CloseHandle(job);
            if (restrictedToken != IntPtr.Zero) CloseHandle(restrictedToken);
            if (originalToken != IntPtr.Zero) CloseHandle(originalToken);
            if (restrictedSidArray != IntPtr.Zero) Marshal.FreeHGlobal(restrictedSidArray);
            foreach (var sid in allocatedSids)
            {
                if (sid != IntPtr.Zero) LocalFree(sid);
            }
            RemoveAppliedRules(appliedRules);
        }
    }

    private static Options ParseOptions(string[] args)
    {
        var options = new Options();
        int i = 0;
        while (i < args.Length)
        {
            var arg = args[i];
            if (arg == "--")
            {
                for (int j = i + 1; j < args.Length; j++)
                {
                    options.Command.Add(args[j]);
                }
                return options;
            }

            if (arg == "--restrict-writes")
            {
                options.RestrictWrites = ReadValue(args, ref i) == "1";
            }
            else if (arg == "--denied-root")
            {
                options.DeniedRoots.Add(ReadValue(args, ref i));
            }
            else if (arg == "--base-writable-root")
            {
                options.BaseWritableRoots.Add(ReadValue(args, ref i));
            }
            else if (arg == "--readonly-root")
            {
                options.ReadonlyRoots.Add(ReadValue(args, ref i));
            }
            else if (arg == "--writable-root")
            {
                options.WritableRoots.Add(ReadValue(args, ref i));
            }
            else
            {
                throw new ArgumentException("unknown argument: " + arg);
            }
            i += 1;
        }
        return options;
    }

    private static string ReadValue(string[] args, ref int index)
    {
        if (index + 1 >= args.Length)
        {
            throw new ArgumentException("missing value for " + args[index]);
        }
        index += 1;
        return args[index];
    }

    private static FileSystemRights DenyRights()
    {
        return FileSystemRights.FullControl;
    }

    private static FileSystemRights WritableRights()
    {
        return FileSystemRights.Modify | FileSystemRights.Synchronize;
    }

    private static FileSystemRights ReadonlyRights()
    {
        return FileSystemRights.ReadAndExecute | FileSystemRights.Synchronize;
    }

    private static void AddReadonlyRuleIfPathExists(string path, SecurityIdentifier sid, List<AppliedRule> appliedRules)
    {
        AddRuleIfPathExists(path, sid, ReadonlyRights(), AccessControlType.Allow, appliedRules);
    }

    private static void AddWritableRule(string path, SecurityIdentifier sid, List<AppliedRule> appliedRules)
    {
        if (String.IsNullOrWhiteSpace(path)) return;
        Directory.CreateDirectory(path);
        AddRule(path, sid, WritableRights(), AccessControlType.Allow, appliedRules, true);
    }

    private static void AddRuleIfPathExists(
        string path,
        SecurityIdentifier sid,
        FileSystemRights rights,
        AccessControlType type,
        List<AppliedRule> appliedRules)
    {
        if (String.IsNullOrWhiteSpace(path)) return;
        if (Directory.Exists(path))
        {
            AddRule(path, sid, rights, type, appliedRules, true);
        }
        else if (File.Exists(path))
        {
            AddRule(path, sid, rights, type, appliedRules, false);
        }
    }

    private static void AddRule(
        string path,
        SecurityIdentifier sid,
        FileSystemRights rights,
        AccessControlType type,
        List<AppliedRule> appliedRules,
        bool isDirectory)
    {
        FileSystemAccessRule rule;
        if (isDirectory)
        {
            rule = new FileSystemAccessRule(
                sid,
                rights,
                InheritanceFlags.ContainerInherit | InheritanceFlags.ObjectInherit,
                PropagationFlags.None,
                type);
            var security = Directory.GetAccessControl(path, AccessControlSections.Access);
            security.AddAccessRule(rule);
            Directory.SetAccessControl(path, security);
        }
        else
        {
            rule = new FileSystemAccessRule(sid, rights, type);
            var security = File.GetAccessControl(path, AccessControlSections.Access);
            security.AddAccessRule(rule);
            File.SetAccessControl(path, security);
        }
        appliedRules.Add(new AppliedRule(path, rule, isDirectory));
    }

    private static void RemoveAppliedRules(List<AppliedRule> appliedRules)
    {
        for (int i = appliedRules.Count - 1; i >= 0; i--)
        {
            var applied = appliedRules[i];
            try
            {
                if (applied.IsDirectory)
                {
                    if (!Directory.Exists(applied.Path)) continue;
                    var security = Directory.GetAccessControl(applied.Path, AccessControlSections.Access);
                    security.RemoveAccessRuleSpecific(applied.Rule);
                    Directory.SetAccessControl(applied.Path, security);
                }
                else
                {
                    if (!File.Exists(applied.Path)) continue;
                    var security = File.GetAccessControl(applied.Path, AccessControlSections.Access);
                    security.RemoveAccessRuleSpecific(applied.Rule);
                    File.SetAccessControl(applied.Path, security);
                }
            }
            catch (Exception error)
            {
                Console.Error.WriteLine("Letta Windows sandbox: failed to remove temporary ACL on " + applied.Path + ": " + error.Message);
            }
        }
    }

    private static IntPtr BuildSidAndAttributesArray(List<string> sidStrings, List<IntPtr> allocatedSids)
    {
        int itemSize = Marshal.SizeOf(typeof(SID_AND_ATTRIBUTES));
        IntPtr buffer = Marshal.AllocHGlobal(itemSize * sidStrings.Count);
        for (int i = 0; i < sidStrings.Count; i++)
        {
            IntPtr sid;
            if (!ConvertStringSidToSid(sidStrings[i], out sid))
            {
                throw new InvalidOperationException("ConvertStringSidToSid failed for " + sidStrings[i] + " (" + Marshal.GetLastWin32Error() + ")");
            }
            allocatedSids.Add(sid);
            var entry = new SID_AND_ATTRIBUTES { Sid = sid, Attributes = SE_GROUP_ENABLED };
            Marshal.StructureToPtr(entry, IntPtr.Add(buffer, itemSize * i), false);
        }
        return buffer;
    }

    private static IntPtr CreateKillOnCloseJob()
    {
        IntPtr job = CreateJobObject(IntPtr.Zero, null);
        if (job == IntPtr.Zero)
        {
            FailLastError("CreateJobObject");
            return IntPtr.Zero;
        }

        var limits = new JOBOBJECT_EXTENDED_LIMIT_INFORMATION();
        limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE | JOB_OBJECT_LIMIT_DIE_ON_UNHANDLED_EXCEPTION;

        IntPtr limitsPtr = Marshal.AllocHGlobal(Marshal.SizeOf(typeof(JOBOBJECT_EXTENDED_LIMIT_INFORMATION)));
        try
        {
            Marshal.StructureToPtr(limits, limitsPtr, false);
            if (!SetInformationJobObject(job, JobObjectExtendedLimitInformation, limitsPtr, (uint)Marshal.SizeOf(typeof(JOBOBJECT_EXTENDED_LIMIT_INFORMATION))))
            {
                FailLastError("SetInformationJobObject");
                CloseHandle(job);
                return IntPtr.Zero;
            }
        }
        finally
        {
            Marshal.FreeHGlobal(limitsPtr);
        }

        return job;
    }

    private static bool StartChild(IntPtr token, IntPtr job, List<string> command, ref PROCESS_INFORMATION processInfo)
    {
        var startup = new STARTUPINFO();
        startup.cb = (uint)Marshal.SizeOf(typeof(STARTUPINFO));
        startup.dwFlags = STARTF_USESTDHANDLES;
        startup.hStdInput = GetStdHandle(STD_INPUT_HANDLE);
        startup.hStdOutput = GetStdHandle(STD_OUTPUT_HANDLE);
        startup.hStdError = GetStdHandle(STD_ERROR_HANDLE);

        string commandLine = BuildCommandLine(command);
        string cwd = Directory.GetCurrentDirectory();
        uint creationFlags = CREATE_BREAKAWAY_FROM_JOB | CREATE_SUSPENDED;

        bool created = CreateProcessAsUser(
            token,
            null,
            commandLine,
            IntPtr.Zero,
            IntPtr.Zero,
            true,
            creationFlags,
            IntPtr.Zero,
            cwd,
            ref startup,
            out processInfo);

        if (!created)
        {
            int firstError = Marshal.GetLastWin32Error();
            created = CreateProcessWithTokenW(
                token,
                LOGON_WITH_PROFILE,
                null,
                commandLine,
                creationFlags,
                IntPtr.Zero,
                cwd,
                ref startup,
                out processInfo);
            if (!created)
            {
                Console.Error.WriteLine("Letta Windows sandbox: CreateProcessAsUser failed (" + firstError + "); CreateProcessWithTokenW failed (" + Marshal.GetLastWin32Error() + "): " + commandLine);
                return false;
            }
        }

        if (!AssignProcessToJobObject(job, processInfo.hProcess))
        {
            int error = Marshal.GetLastWin32Error();
            Console.Error.WriteLine("Letta Windows sandbox: AssignProcessToJobObject failed (" + error + ")");
            TerminateProcess(processInfo.hProcess, 1);
            return false;
        }

        ResumeThread(processInfo.hThread);
        return true;
    }

    private static string BuildCommandLine(List<string> command)
    {
        var parts = new List<string>();
        foreach (var part in command)
        {
            parts.Add(QuoteArgument(part));
        }
        return String.Join(" ", parts.ToArray());
    }

    private static string QuoteArgument(string arg)
    {
        if (String.IsNullOrEmpty(arg)) return "\"\"";

        bool needsQuotes = false;
        foreach (char ch in arg)
        {
            if (Char.IsWhiteSpace(ch) || ch == '"')
            {
                needsQuotes = true;
                break;
            }
        }
        if (!needsQuotes) return arg;

        var result = new StringBuilder();
        result.Append('"');
        int backslashes = 0;
        foreach (char ch in arg)
        {
            if (ch == '\\')
            {
                backslashes += 1;
                continue;
            }
            if (ch == '"')
            {
                result.Append('\\', backslashes * 2 + 1);
                result.Append('"');
                backslashes = 0;
                continue;
            }
            result.Append('\\', backslashes);
            backslashes = 0;
            result.Append(ch);
        }
        result.Append('\\', backslashes * 2);
        result.Append('"');
        return result.ToString();
    }

    private static string CreateSandboxSid()
    {
        byte[] bytes = new byte[32];
        Buffer.BlockCopy(Guid.NewGuid().ToByteArray(), 0, bytes, 0, 16);
        Buffer.BlockCopy(Guid.NewGuid().ToByteArray(), 0, bytes, 16, 16);

        var parts = new List<string>();
        for (int i = 0; i < bytes.Length; i += 4)
        {
            parts.Add(BitConverter.ToUInt32(bytes, i).ToString(System.Globalization.CultureInfo.InvariantCulture));
        }
        return "S-1-15-3-" + String.Join("-", parts.ToArray());
    }

    private static int FailLastError(string operation)
    {
        Console.Error.WriteLine("Letta Windows sandbox: " + operation + " failed (" + Marshal.GetLastWin32Error() + ")");
        return 1;
    }
}