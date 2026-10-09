using ForeverDB.Companion.Models;

namespace ForeverDB.Companion.Services;

// Search scope changes replace result objects. Match by stable entity identity,
// not by WPF object reference or display name.
public static class SearchResultSelection
{
    public static SearchResultItem? FindMatching(
        IReadOnlyList<SearchResultItem> results,
        SearchResultItem? previouslySelected)
    {
        return previouslySelected is null
            ? null
            : results.FirstOrDefault(
                result => SameEntity(result, previouslySelected));
    }

    public static bool SameEntity(
        SearchResultItem left,
        SearchResultItem right)
    {
        if (left.Kind != right.Kind)
        {
            return false;
        }

        return left.Kind == SearchEntityKind.Item
            ? left.ItemId == right.ItemId
            : left.SourceType == right.SourceType &&
              left.SourceId == right.SourceId &&
              left.SourceLevel == right.SourceLevel;
    }
}
