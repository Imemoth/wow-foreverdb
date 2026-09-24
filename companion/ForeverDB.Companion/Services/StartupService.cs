using Microsoft.Win32;

namespace ForeverDB.Companion.Services;

public static class StartupService
{
    private const string RunKey =
        @"Software\Microsoft\Windows\CurrentVersion\Run";

    private const string ValueName = "ForeverDB Companion";

    public static void SetEnabled(bool enabled)
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
                key.SetValue(ValueName, $""{executable}"");
            }
        }
        else
        {
            key.DeleteValue(ValueName, throwOnMissingValue: false);
        }
    }
}
