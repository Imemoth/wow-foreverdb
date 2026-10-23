namespace ForeverDB.AtlasExporter.Model;

/// <summary>One active product row of the client's .build.info.</summary>
public sealed record BuildInfoEntry(
    string Product,
    string Version,
    string Branch,
    string BuildKey,
    string CdnKey,
    string Tags,
    bool Active);

public sealed record ClientInstall(
    string CascRoot,
    string? BranchDirectory,
    IReadOnlyList<BuildInfoEntry> Entries);

public sealed record SelectedClient(
    string CascRoot,
    string Product,
    string Version,
    string Region,
    string BuildKey);
