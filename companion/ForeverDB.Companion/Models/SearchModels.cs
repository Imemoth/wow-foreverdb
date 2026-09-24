namespace ForeverDB.Companion.Models;

public enum SearchEntityKind
{
    Item,
    Source
}

public sealed class SearchResultItem
{
    public SearchEntityKind Kind { get; init; }
    public long ItemId { get; init; }
    public string SourceType { get; init; } = "";
    public long SourceId { get; init; }
    public int SourceLevel { get; init; }
    public string Name { get; init; } = "";
    public string DisplayText { get; init; } = "";

    public override string ToString() => DisplayText;
}

public sealed class EntityDetail
{
    public string Title { get; init; } = "";
    public string Subtitle { get; init; } = "";
    public IReadOnlyList<DetailGroup> Groups { get; init; } =
        Array.Empty<DetailGroup>();
}

public sealed class DetailGroup
{
    public string Key { get; init; } = "";
    public string Title { get; init; } = "";
    public IReadOnlyList<DetailRow> Rows { get; init; } =
        Array.Empty<DetailRow>();
}

public sealed class DetailRow
{
    public string Name { get; init; } = "";
    public string Level { get; init; } = "";
    public string SourceType { get; init; } = "";
    public long Drops { get; init; }
    public long Observations { get; init; }
    public long Quantity { get; init; }
    public long QuestDrops { get; init; }
    public double RatePercent { get; init; }
    public double ConfidenceScore { get; init; }

    public string Rate => $"{RatePercent:0.0}%";
}
