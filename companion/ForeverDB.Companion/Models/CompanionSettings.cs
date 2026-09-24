namespace ForeverDB.Companion.Models;

public sealed class CompanionSettings
{
    public string WowRoot { get; set; } = "";
    public string SupabaseUrl { get; set; } = "https://klxhikdlfwgxurdyexdi.supabase.co";
    public string SupabaseKey { get; set; } = "";
    public bool AutoSync { get; set; } = true;
    public bool LaunchWithWindows { get; set; }
    public bool StartMinimized { get; set; } = true;
}
