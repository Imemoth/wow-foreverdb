using ForeverDB.Companion.Models;

namespace ForeverDB.Companion.Services;

public sealed class GuildbookRosterFilterResult
{
    public required IReadOnlyList<ForeverDbGuildMember> Members { get; init; }
    public int TotalCount { get; init; }
    public int TotalOnlineCount { get; init; }
    public int VisibleOnlineCount { get; init; }
    public bool HasActiveFilter { get; init; }

    public int VisibleCount => Members.Count;
    public int TotalOfflineCount => TotalCount - TotalOnlineCount;
    public int VisibleOfflineCount => VisibleCount - VisibleOnlineCount;

    public string MembersCountText =>
        FormatCount(VisibleCount, TotalCount);

    public string OnlineCountText =>
        FormatCount(VisibleOnlineCount, TotalOnlineCount);

    public string OfflineCountText =>
        FormatCount(VisibleOfflineCount, TotalOfflineCount);

    private string FormatCount(
        int visible,
        int total)
        => HasActiveFilter
            ? $"{visible}/{total}"
            : total.ToString();
}

public static class GuildbookRosterFilter
{
    private const string AllProfessions = "All professions";

    public static GuildbookRosterFilterResult Apply(
        IReadOnlyCollection<ForeverDbGuildMember> members,
        string? textFilter,
        string? professionFilter,
        bool onlineOnly)
    {
        var query =
            textFilter?
                .Trim()
            ?? "";

        var selectedProfession =
            professionFilter?
                .Trim()
            ?? "";

        var hasProfessionFilter =
            !string.IsNullOrWhiteSpace(selectedProfession) &&
            !string.Equals(
                selectedProfession,
                AllProfessions,
                StringComparison.OrdinalIgnoreCase);

        var hasTextFilter =
            !string.IsNullOrWhiteSpace(query);

        var visibleMembers = members
            .Where(
                member =>
                    !onlineOnly ||
                    member.Online)
            .Where(
                member =>
                    !hasProfessionFilter ||
                    member.Professions.Any(
                        profession =>
                            string.Equals(
                                profession.Name,
                                selectedProfession,
                                StringComparison.OrdinalIgnoreCase)))
            .Where(
                member =>
                    !hasTextFilter ||
                    MatchesText(
                        member,
                        query))
            .ToList();

        return new GuildbookRosterFilterResult
        {
            Members = visibleMembers,
            TotalCount = members.Count,
            TotalOnlineCount =
                members.Count(
                    member =>
                        member.Online),
            VisibleOnlineCount =
                visibleMembers.Count(
                    member =>
                        member.Online),
            HasActiveFilter =
                onlineOnly ||
                hasProfessionFilter ||
                hasTextFilter
        };
    }

    private static bool MatchesText(
        ForeverDbGuildMember member,
        string query)
        => Contains(
               member.Name,
               query) ||
           Contains(
               member.ClassName,
               query) ||
           Contains(
               member.RankName,
               query) ||
           Contains(
               member.Zone,
               query) ||
           member.Professions.Any(
               profession =>
                   Contains(
                       FormatProfession(
                           profession),
                       query));

    private static string FormatProfession(
        ForeverDbGuildProfession profession)
    {
        var skillText =
            profession.MaxSkill > 0
                ? $"{profession.Skill}/{profession.MaxSkill}"
                : profession.Skill > 0
                    ? profession.Skill.ToString()
                    : "";

        return string.IsNullOrWhiteSpace(skillText)
            ? profession.Name
            : $"{profession.Name} {skillText}";
    }

    private static bool Contains(
        string value,
        string query)
        => value.Contains(
            query,
            StringComparison.OrdinalIgnoreCase);
}
