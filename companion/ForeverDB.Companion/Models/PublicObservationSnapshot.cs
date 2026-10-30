namespace ForeverDB.Companion.Models;

/// <summary>
/// The ONLY shape that is serialized into a public observation upload. It is built field by field from a parsed
/// <see cref="ForeverDbSnapshot"/> and deliberately has no Guildbook member, so Guildbook can never reach a transport by "serialize the
/// whole snapshot" or by a future property being added to the snapshot. (<see cref="ForeverDB.Companion.Account.PublicSnapshotGuard"/> is
/// the second, independent layer, checking the final JSON at the point where it leaves the process.)
///
/// Not carried, on purpose: guild names and rosters, member names and GUIDs, professions, ranks, online activity, and the Guildbook
/// capture metadata. Those stay on this computer (LocalGuildbookStore).
/// </summary>
public sealed record PublicObservationSnapshot(
    int SchemaVersion,
    string AddonVersion,
    string InstallationId,
    long UpdatedAt,
    IReadOnlyList<ForeverDbSource> Sources,
    IReadOnlyList<ForeverDbMap> Maps)
{
    public static PublicObservationSnapshot From(ForeverDbSnapshot snapshot) => new(
        snapshot.SchemaVersion,
        snapshot.AddonVersion,
        snapshot.InstallationId,
        snapshot.UpdatedAt,
        snapshot.Sources,
        snapshot.Maps);
}
