namespace ForeverDB.Companion.Models;

public sealed class AuthSession
{
    public string AccessToken { get; set; } = "";
    public string RefreshToken { get; set; } = "";
    public long ExpiresAt { get; set; }
    public string UserId { get; set; } = "";
}
