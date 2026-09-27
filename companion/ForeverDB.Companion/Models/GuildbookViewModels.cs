using System.Windows.Media;

namespace ForeverDB.Companion.Models;

public sealed class GuildbookProfessionChip
{
    public string Name { get; init; } = "";
    public string SkillText { get; init; } = "";
    public bool IsSecondary { get; init; }

    public string Display =>
        string.IsNullOrWhiteSpace(SkillText)
            ? Name
            : $"{Name} {SkillText}";

    public Brush BackgroundBrush =>
        new SolidColorBrush(
            (Color)ColorConverter.ConvertFromString(
                IsSecondary
                    ? "#202B3A"
                    : "#2E2719"));

    public Brush BorderBrush =>
        new SolidColorBrush(
            (Color)ColorConverter.ConvertFromString(
                IsSecondary
                    ? "#3B526E"
                    : "#705A2B"));
}

public sealed class GuildbookMemberRow
{
    public string Guid { get; init; } = "";
    public string Name { get; init; } = "";
    public string ClassName { get; init; } = "";
    public string ClassFile { get; init; } = "";
    public int Level { get; init; }
    public string RankName { get; init; } = "";
    public int RankIndex { get; init; }
    public bool Online { get; init; }
    public string Zone { get; init; } = "";
    public long LastOnlineHours { get; init; }
    public string Professions { get; init; } = "";
    public IReadOnlyList<string> ProfessionNames { get; init; } =
        Array.Empty<string>();
    public IReadOnlyList<GuildbookProfessionChip> ProfessionChips { get; init; } =
        Array.Empty<GuildbookProfessionChip>();

    public string Status =>
        Online
            ? "Online"
            : LastOnlineHours > 0
                ? FormatLastOnline(LastOnlineHours)
                : "Offline";

    public Brush ClassBrush =>
        new SolidColorBrush(
            ClassFile.ToUpperInvariant() switch
            {
                "WARRIOR" => Color.FromRgb(199, 156, 110),
                "PALADIN" => Color.FromRgb(245, 140, 186),
                "HUNTER" => Color.FromRgb(171, 212, 115),
                "ROGUE" => Color.FromRgb(255, 245, 105),
                "PRIEST" => Color.FromRgb(255, 255, 255),
                "SHAMAN" => Color.FromRgb(0, 112, 222),
                "MAGE" => Color.FromRgb(105, 204, 240),
                "WARLOCK" => Color.FromRgb(148, 130, 201),
                "DRUID" => Color.FromRgb(255, 125, 10),
                _ => Color.FromRgb(216, 222, 233)
            });

    public Brush StatusBrush =>
        new SolidColorBrush(
            Online
                ? Color.FromRgb(83, 199, 147)
                : Color.FromRgb(152, 164, 181));

    private static string FormatLastOnline(long hours)
    {
        if (hours < 24)
        {
            return $"{hours}h ago";
        }

        var days = hours / 24;

        if (days < 30)
        {
            return $"{days}d ago";
        }

        var months = days / 30;

        if (months < 12)
        {
            return $"{months}mo ago";
        }

        return $"{months / 12}y ago";
    }

    public static GuildbookMemberRow From(
        ForeverDbGuildMember member)
    {
        var orderedProfessions = member.Professions
            .OrderBy(profession => profession.IsSecondary)
            .ThenBy(profession => profession.Name)
            .ToList();

        var chips = orderedProfessions
            .Select(
                profession =>
                    new GuildbookProfessionChip
                    {
                        Name = profession.Name,
                        SkillText =
                            profession.MaxSkill > 0
                                ? $"{profession.Skill}/{profession.MaxSkill}"
                                : profession.Skill > 0
                                    ? profession.Skill.ToString()
                                    : "",
                        IsSecondary = profession.IsSecondary
                    })
            .ToList();

        return new GuildbookMemberRow
        {
            Guid = member.Guid,
            Name = member.Name,
            ClassName = member.ClassName,
            ClassFile = member.ClassFile,
            Level = member.Level,
            RankName = member.RankName,
            RankIndex = member.RankIndex,
            Online = member.Online,
            Zone = member.Zone,
            LastOnlineHours = member.LastOnlineHours,
            ProfessionNames = orderedProfessions
                .Select(profession => profession.Name)
                .Where(name => !string.IsNullOrWhiteSpace(name))
                .Distinct(StringComparer.OrdinalIgnoreCase)
                .ToList(),
            ProfessionChips = chips,
            Professions = string.Join(
                "  •  ",
                chips.Select(chip => chip.Display))
        };
    }
}
