namespace ForeverDB.Companion.Models;

public sealed class ForeverDbSnapshot
{
    public int SchemaVersion { get; set; }
    public string AddonVersion { get; set; } = "";
    public string InstallationId { get; set; } = "";
    public long UpdatedAt { get; set; }
    public List<ForeverDbSource> Sources { get; set; } = new();
}

public sealed class ForeverDbSource
{
    public string SourceType { get; set; } = "";
    public long SourceId { get; set; }
    public int SourceLevel { get; set; }
    public string Name { get; set; } = "";
    public List<ForeverDbBucket> Buckets { get; set; } = new();
}

public sealed class ForeverDbBucket
{
    public string Kind { get; set; } = "";
    public long Observations { get; set; }
    public List<ForeverDbItem> Items { get; set; } = new();
    public List<ForeverDbLocation> Locations { get; set; } = new();
}

public sealed class ForeverDbItem
{
    public long ItemId { get; set; }
    public string Name { get; set; } = "";
    public long Drops { get; set; }
    public long Quantity { get; set; }
    public long QuestDrops { get; set; }
    public List<long> QuestIds { get; set; } = new();
}

public sealed class ForeverDbLocation
{
    public long MapId { get; set; }
    public string ZoneName { get; set; } = "";
    public string SubZoneName { get; set; } = "";
    public string X { get; set; } = "";
    public string Y { get; set; } = "";
    public long Observations { get; set; }
}
