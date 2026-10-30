using ForeverDB.Companion.Services;
using Xunit;

namespace ForeverDB.Companion.Account.Tests;

public sealed class SyntheticFixtureContractTests
{
    [Fact]
    public void Generated_saved_variables_are_accepted_by_the_real_companion_parser()
    {
        // The ordinary Account test suite also runs without the optional fixture;
        // the dedicated Windows fixture workflow always sets both variables.
        var path = Environment.GetEnvironmentVariable("FOREVERDB_SYNTHETIC_FIXTURE_FILE");
        var stage = Environment.GetEnvironmentVariable("FOREVERDB_SYNTHETIC_FIXTURE_STAGE");
        if (string.IsNullOrEmpty(path) && string.IsNullOrEmpty(stage)) return;
        Assert.False(string.IsNullOrWhiteSpace(path));
        Assert.Contains(stage, new[] { "A", "B" });

        var parsed = new ForeverDbExportParser().ParseSavedVariables(path!);
        Assert.Equal(9, parsed.SchemaVersion);
        Assert.Equal("0.9.0-alpha", parsed.AddonVersion);
        Assert.Matches("^[0-9a-f]{32}$", parsed.InstallationId);
        Assert.NotNull(parsed.GuildbookCaptureId);
        Assert.NotNull(parsed.GuildbookCapturedAt);
        Assert.True(parsed.GuildbookCapturedAt > 0);
        Assert.Equal("SyntheticCharacter" + stage, parsed.GuildbookSourceCharacter);

        var guild = Assert.Single(parsed.Guilds);
        Assert.Equal("Synthetic Guild " + stage, guild.Name);
        Assert.Equal("SyntheticRealm", guild.RealmName);
        var member = Assert.Single(guild.Members);
        Assert.Equal("Member" + stage, member.Name);
        Assert.Equal("MAGE", member.ClassFile);
        Assert.Equal(60, member.Level);
        Assert.True(member.Online);
        var profession = Assert.Single(member.Professions);
        Assert.Equal("Alchemy", profession.Name);
        Assert.Equal(171, profession.SkillLineId);

        // The offline fixture never needs to contain public observations:
        // a manual online sync could otherwise create an unintended upload.
        Assert.Empty(parsed.Sources);
        Assert.Empty(parsed.Maps);
    }
}
