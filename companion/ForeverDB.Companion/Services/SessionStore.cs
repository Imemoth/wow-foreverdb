using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using ForeverDB.Companion.Models;

namespace ForeverDB.Companion.Services;

public static class SessionStore
{
    private static readonly string DirectoryPath =
        Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
            "ForeverDB");

    private static readonly string SessionPath =
        Path.Combine(DirectoryPath, "session.dat");

    public static AuthSession? Load()
    {
        if (!File.Exists(SessionPath))
        {
            return null;
        }

        try
        {
            var encrypted = Convert.FromBase64String(
                File.ReadAllText(SessionPath));

            var plain = ProtectedData.Unprotect(
                encrypted,
                optionalEntropy: null,
                DataProtectionScope.CurrentUser);

            return JsonSerializer.Deserialize<AuthSession>(
                Encoding.UTF8.GetString(plain));
        }
        catch
        {
            return null;
        }
    }

    public static void Save(AuthSession session)
    {
        Directory.CreateDirectory(DirectoryPath);

        var plain = Encoding.UTF8.GetBytes(
            JsonSerializer.Serialize(session));

        var encrypted = ProtectedData.Protect(
            plain,
            optionalEntropy: null,
            DataProtectionScope.CurrentUser);

        File.WriteAllText(
            SessionPath,
            Convert.ToBase64String(encrypted));
    }

    public static void Clear()
    {
        if (File.Exists(SessionPath))
        {
            File.Delete(SessionPath);
        }
    }
}
