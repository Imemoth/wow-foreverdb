namespace ForeverDB.Companion.Models;

public sealed class ForeverDbSnapshot
{
    public int SchemaVersion { get; set; }
    public string AddonVersion { get; set; } = "";
    public string InstallationId { get; set; } = "";
    public long UpdatedAt { get; set; }
    public List<ForeverDbSource> Sources { get; set; } = new();
    public List<ForeverDbMap> Maps { get; set; } = new();
    public List<ForeverDbGuild> Guilds { get; set; } = new();
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


public sealed class ForeverDbMap
{
    public long MapId { get; set; }
    public string Name { get; set; } = "";
    public long ParentMapId { get; set; }
    public long MapArtId { get; set; }
    public List<ForeverDbMapLayer> Layers { get; set; } = new();
}

public sealed class ForeverDbMapLayer
{
    public int LayerIndex { get; set; }
    public int LayerWidth { get; set; }
    public int LayerHeight { get; set; }
    public int TileWidth { get; set; }
    public int TileHeight { get; set; }
    public double MinScale { get; set; }
    public double MaxScale { get; set; }
    public int AdditionalZoomSteps { get; set; }
    public List<string> TextureRefs { get; set; } = new();
}


public sealed class ForeverDbGuild
{
    public string GuildKey { get; set; } = "";
    public string Name { get; set; } = "";
    public string RealmName { get; set; } = "";
    public long CapturedAt { get; set; }
    public List<ForeverDbGuildMember> Members { get; set; } = new();

    public override string ToString()
        => string.IsNullOrWhiteSpace(RealmName)
            ? Name
            : $"{Name} — {RealmName}";
}

public sealed class ForeverDbGuildMember
{
    public string Guid { get; set; } = "";
    public string Name { get; set; } = "";
    public string ClassName { get; set; } = "";
    public string ClassFile { get; set; } = "";
    public int Level { get; set; }
    public string RankName { get; set; } = "";
    public int RankIndex { get; set; }
    public bool Online { get; set; }
    public string Zone { get; set; } = "";
    public long LastOnlineHours { get; set; }
    public List<ForeverDbGuildProfession> Professions { get; set; } = new();
}

public sealed class ForeverDbGuildProfession
{
    public int SkillLineId { get; set; }
    public string Name { get; set; } = "";
    public int Skill { get; set; }
    public int MaxSkill { get; set; }
    public string Source { get; set; } = "";
    public bool IsSecondary { get; set; }
}
