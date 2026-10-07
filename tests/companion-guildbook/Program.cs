using ForeverDB.Companion.Models;
using ForeverDB.Companion.Services;

var failures = new List<string>();
var assertionCount = 0;

void Check(bool condition, string name)
{
    assertionCount++;

    if (!condition)
    {
        failures.Add(name);
    }
}

ForeverDbGuildMember Member(
    string name,
    bool online,
    string className,
    string rank,
    string zone,
    params (string Name, bool Secondary)[] professions)
    => new()
    {
        Name = name,
        Online = online,
        ClassName = className,
        RankName = rank,
        Zone = zone,
        Professions = professions
            .Select(
                profession =>
                    new ForeverDbGuildProfession
                    {
                        Name = profession.Name,
                        IsSecondary = profession.Secondary,
                        Skill = 75,
                        MaxSkill = 150
                    })
            .ToList()
    };

var members = new List<ForeverDbGuildMember>
{
    Member(
        "Vesperix",
        true,
        "Rogue",
        "Officer",
        "Tirisfal Glades",
        ("Skinning", false),
        ("Cooking", true)),
    Member(
        "Imemoth",
        true,
        "Druid",
        "Member",
        "Mulgore",
        ("Herbalism", false),
        ("Cooking", true)),
    Member(
        "Melbane",
        false,
        "Paladin",
        "Member",
        "Tirisfal Glades",
        ("Mining", false),
        ("First Aid", true)),
    Member(
        "Monory",
        false,
        "Priest",
        "Initiate",
        "Silverpine Forest",
        ("Tailoring", false))
};

var unfiltered =
    GuildbookRosterFilter.Apply(
        members,
        textFilter: "",
        professionFilter: "All professions",
        onlineOnly: false);

Check(unfiltered.VisibleCount == 4,
    "unfiltered roster keeps every member");
Check(unfiltered.TotalOnlineCount == 2,
    "unfiltered total online count");
Check(unfiltered.VisibleOnlineCount == 2,
    "unfiltered visible online count");
Check(unfiltered.MembersCountText == "4",
    "unfiltered members counter is compact");
Check(unfiltered.OnlineCountText == "2",
    "unfiltered online counter is compact");
Check(unfiltered.OfflineCountText == "2",
    "unfiltered offline counter is compact");

var onlineOnly =
    GuildbookRosterFilter.Apply(
        members,
        textFilter: "",
        professionFilter: "All professions",
        onlineOnly: true);

Check(onlineOnly.VisibleCount == 2,
    "online-only removes offline members");
Check(onlineOnly.MembersCountText == "2/4",
    "online-only members counter is visible/total");
Check(onlineOnly.OnlineCountText == "2/2",
    "active filter keeps visible/total even when every online member matches");
Check(onlineOnly.OfflineCountText == "0/2",
    "online-only offline counter is visible/total");

var profession =
    GuildbookRosterFilter.Apply(
        members,
        textFilter: "",
        professionFilter: "Cooking",
        onlineOnly: false);

Check(
    profession.Members.Select(member => member.Name)
        .SequenceEqual(new[] { "Vesperix", "Imemoth" }),
    "profession filter matches exact profession names case-insensitively");
Check(profession.MembersCountText == "2/4",
    "profession-filter members counter");
Check(profession.OnlineCountText == "2/2",
    "profession-filter online counter");
Check(profession.OfflineCountText == "0/2",
    "profession-filter offline counter");

var text =
    GuildbookRosterFilter.Apply(
        members,
        textFilter: "tirisfal",
        professionFilter: "All professions",
        onlineOnly: false);

Check(
    text.Members.Select(member => member.Name)
        .SequenceEqual(new[] { "Vesperix", "Melbane" }),
    "text filter matches zone");

var professionText =
    GuildbookRosterFilter.Apply(
        members,
        textFilter: "cooking 75/150",
        professionFilter: "All professions",
        onlineOnly: false);

Check(professionText.VisibleCount == 2,
    "text filter matches rendered profession skill text");

var allMatchText =
    GuildbookRosterFilter.Apply(
        members,
        textFilter: "member",
        professionFilter: "All professions",
        onlineOnly: false);

Check(allMatchText.HasActiveFilter,
    "text filter is active even when results can equal totals");
Check(allMatchText.MembersCountText == "2/4",
    "text filter reports visible/total");

var allOnlineMembers = members
    .Select(
        member =>
            new ForeverDbGuildMember
            {
                Name = member.Name,
                Online = true,
                ClassName = member.ClassName,
                RankName = member.RankName,
                Zone = member.Zone,
                Professions = member.Professions
            })
    .ToList();

var allOnlineFiltered =
    GuildbookRosterFilter.Apply(
        allOnlineMembers,
        textFilter: "",
        professionFilter: "All professions",
        onlineOnly: true);

Check(allOnlineFiltered.VisibleCount == 4,
    "online-only can match the full roster");
Check(allOnlineFiltered.HasActiveFilter,
    "online-only remains an active filter when it matches the full roster");
Check(allOnlineFiltered.MembersCountText == "4/4",
    "active all-match filter still exposes visible/total members");
Check(allOnlineFiltered.OnlineCountText == "4/4",
    "active all-match filter still exposes visible/total online");
Check(allOnlineFiltered.OfflineCountText == "0/0",
    "active all-match filter handles zero offline total deterministically");

if (failures.Count > 0)
{
    Console.Error.WriteLine(
        $"Companion Guildbook checks FAILED ({failures.Count}):");

    foreach (var failure in failures)
    {
        Console.Error.WriteLine($" - {failure}");
    }

    return 1;
}

Console.WriteLine(
    $"Companion Guildbook checks PASS ({assertionCount} assertions).");
return 0;
