using ForeverDB.Companion.Services;
using Xunit;

namespace ForeverDB.Companion.Account.Tests;

public sealed class WowInstallationLocatorTests
{
    [Fact]
    public void Empty_directory_is_rejected_with_a_useful_message()
    {
        var root = TestEnv.NewDirectory();

        var result = WowInstallationLocator.Validate(root);

        Assert.False(result.IsValid);
        Assert.False(result.IsSyncReady);
        Assert.Contains("game folder", result.Message, StringComparison.OrdinalIgnoreCase);
    }

    [Fact]
    public void Existing_savedvariables_tree_is_valid_and_ready_even_for_a_custom_folder_name()
    {
        var root = TestEnv.NewDirectory();
        Directory.CreateDirectory(Path.Combine(root, "WTF", "Account", "TEST", "SavedVariables"));

        var result = WowInstallationLocator.Validate(root);

        Assert.True(result.IsValid);
        Assert.True(result.IsSyncReady);
        Assert.Contains("ready", result.Message, StringComparison.OrdinalIgnoreCase);
    }

    [Fact]
    public void Installed_client_without_savedvariables_is_valid_but_explains_how_to_make_it_sync_ready()
    {
        var parent = TestEnv.NewDirectory();
        var root = Path.Combine(parent, "_classic_beta_");
        Directory.CreateDirectory(Path.Combine(root, "Interface", "AddOns"));

        var result = WowInstallationLocator.Validate(root);

        Assert.True(result.IsValid);
        Assert.False(result.IsSyncReady);
        Assert.Contains("run", result.Message, StringComparison.OrdinalIgnoreCase);
    }

    [Fact]
    public void Discovery_is_bounded_to_known_flavors_and_returns_only_valid_distinct_candidates()
    {
        var parent = TestEnv.NewDirectory();
        var beta = Path.Combine(parent, "_classic_beta_");
        var era = Path.Combine(parent, "_classic_era_");
        Directory.CreateDirectory(Path.Combine(beta, "WTF", "Account"));
        Directory.CreateDirectory(Path.Combine(era, "Interface", "AddOns"));
        Directory.CreateDirectory(Path.Combine(parent, "unrelated", "WTF", "Account"));

        var candidates = WowInstallationLocator.Discover(new[] { parent, parent });

        Assert.Equal(2, candidates.Count);
        Assert.Equal(beta, candidates[0].Root);
        Assert.True(candidates[0].IsSyncReady);
        Assert.Equal(era, candidates[1].Root);
        Assert.False(candidates[1].IsSyncReady);
    }

    [Fact]
    public void Missing_directory_is_rejected_without_throwing()
    {
        var result = WowInstallationLocator.Validate(Path.Combine(TestEnv.NewDirectory(), "missing"));

        Assert.False(result.IsValid);
        Assert.Contains("does not exist", result.Message, StringComparison.OrdinalIgnoreCase);
    }
}
