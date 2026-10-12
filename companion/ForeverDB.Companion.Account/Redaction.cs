using System.Text.RegularExpressions;

namespace ForeverDB.Companion.Account;

/// <summary>Removes secrets from anything that may reach a log, status line or exception message.</summary>
public static class Redaction
{
    private static readonly (Regex Pattern, string Replacement)[] Rules =
    {
        (new Regex(@"\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*", RegexOptions.Compiled), "[jwt]"),
        (new Regex(@"\bsb_(?:publishable|secret)_[A-Za-z0-9._-]+", RegexOptions.Compiled), "[key]"),
        (new Regex(@"\bFDB(?:-[0-9A-Fa-f]{4}){8}\b", RegexOptions.Compiled), "[claim-code]"),
        (new Regex(@"\b[0-9A-Fa-f]{32}\b", RegexOptions.Compiled), "[hex32]"),
        (new Regex(@"(?i)\b(?:bearer|apikey|access_token|refresh_token|password|token)\b\s*[:=]?\s*""?[^\s,;""}]+", RegexOptions.Compiled), "[secret]"),
        (new Regex(@"[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}", RegexOptions.Compiled), "[email]"),
        (new Regex(@"(?i)(?:[A-Z]:\\|\\\\)[^""'\r\n]+", RegexOptions.Compiled), "[path]"),
    };

    public static string Scrub(string? text, int maxLength = 200)
    {
        if (string.IsNullOrEmpty(text))
        {
            return "";
        }

        var result = text;
        foreach (var (pattern, replacement) in Rules)
        {
            result = pattern.Replace(result, replacement);
        }

        result = Regex.Replace(result, @"\s+", " ").Trim();
        return result.Length <= maxLength ? result : result[..maxLength];
    }
}
