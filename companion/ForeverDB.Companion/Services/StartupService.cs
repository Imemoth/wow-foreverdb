using Microsoft.Win32;

namespace ForeverDB.Companion.Services;

public static class StartupService
{
    private const string RunKey =
        @"Software\Microsoft\Windows\CurrentVersion\Run";

    private const string ValueName = "ForeverDB Companion";

    public static void SetEnabled(
        bool enabled,
        bool startMinimized)
    {
        using var key = Registry.CurrentUser.OpenSubKey(
            RunKey,
            writable: true);

        if (key is null)
        {
            return;
        }

        if (enabled)
        {
            var executable = Environment.ProcessPath;
            if (!string.IsNullOrWhiteSpace(executable))
            {
                var command = $"\"{executable}\"";

                if (startMinimized)
                {
                    command += " --minimized";
                }

                key.SetValue(ValueName, command);
            }
        }
        else
        {
            key.DeleteValue(ValueName, throwOnMissingValue: false);
        }
    }
}
