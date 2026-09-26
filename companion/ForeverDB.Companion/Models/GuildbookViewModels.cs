namespace ForeverDB.Companion.Models;

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

    public string Status =>
        Online
            ? "Online"
            : LastOnlineHours > 0
                ? FormatLastOnline(LastOnlineHours)
                : "Offline";

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
        var professions = member.Professions
            .OrderBy(profession => profession.IsSecondary)
            .ThenBy(profession => profession.Name)
            .Select(
                profession =>
                {
                    var skill =
                        profession.MaxSkill > 0
                            ? $"{profession.Skill}/{profession.MaxSkill}"
                            : profession.Skill > 0
                                ? profession.Skill.ToString()
                                : "?";

                    return $"{profession.Name} {skill}";
                });

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
            Professions = string.Join("  •  ", professions)
        };
    }
}
