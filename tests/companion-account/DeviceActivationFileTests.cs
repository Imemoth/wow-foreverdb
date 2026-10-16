using System.Text;
using System.Text.Json;
using Xunit;

namespace ForeverDB.Companion.Account.Tests;

/// <summary>The activation file contract: strict parsing, safe discovery, no secret in any text form.</summary>
public class DeviceActivationFileTests
{
    private static readonly string Ticket = "fdba1_" + new string('A', 43);

    private static byte[] Json(object o) => JsonSerializer.SerializeToUtf8Bytes(o);

    private static Dictionary<string, object> Valid() => new()
    {
        ["format"] = "foreverdb-activation",
        ["v"] = 1,
        ["ticket"] = Ticket,
        ["expiresAt"] = "2026-10-20T12:00:00.000Z",
        ["createdAt"] = "2026-10-13T12:00:00.000Z"
    };

    [Fact]
    public void Valid_file_is_parsed_and_the_ticket_is_available_only_through_its_hash()
    {
        var result = ActivationFileParser.Parse(Json(Valid()));
        Assert.True(result.Ok);
        Assert.Equal(ActivationParseError.None, result.Error);
        Assert.Equal(64, result.Ticket!.Hash.Length);
        Assert.DoesNotContain("fdba1_", result.Ticket.Hash);
        Assert.Equal(DateTimeOffset.Parse("2026-10-20T12:00:00Z"), result.Ticket.ExpiresAt);
    }

    [Fact]
    public void Files_over_one_kibibyte_are_refused_without_parsing()
    {
        var big = Valid();
        big["padding"] = new string('x', 1100);
        var bytes = Json(big);
        Assert.True(bytes.Length > DeviceContract.MaxActivationFileBytes);
        Assert.Equal(ActivationParseError.TooLarge, ActivationFileParser.Parse(bytes).Error);
        Assert.Equal(ActivationParseError.None, ActivationFileParser.Parse(Json(Valid())).Error);
    }

    [Fact]
    public void A_file_of_exactly_one_kibibyte_is_still_accepted()
    {
        var o = Valid();
        o["pad"] = "";
        var baseLength = Json(o).Length;
        o["pad"] = new string('p', DeviceContract.MaxActivationFileBytes - baseLength);
        var bytes = Json(o);
        Assert.Equal(DeviceContract.MaxActivationFileBytes, bytes.Length);
        Assert.True(ActivationFileParser.Parse(bytes).Ok);
    }

    [Theory]
    [InlineData("format", "other", ActivationParseError.WrongFormat)]
    [InlineData("format", null, ActivationParseError.BadField)]
    [InlineData("v", 2, ActivationParseError.UnsupportedVersion)]
    [InlineData("v", "1", ActivationParseError.BadField)]
    [InlineData("v", 1.5, ActivationParseError.BadField)]
    [InlineData("ticket", "fdba1_short", ActivationParseError.BadTicket)]
    [InlineData("ticket", 12, ActivationParseError.BadTicket)]
    [InlineData("expiresAt", 12, ActivationParseError.BadField)]
    [InlineData("expiresAt", "not a date", ActivationParseError.BadField)]
    [InlineData("createdAt", true, ActivationParseError.BadField)]
    public void Known_fields_must_have_their_documented_values_and_types(string field, object? value, ActivationParseError expected)
    {
        var o = Valid();
        o[field] = value!;
        Assert.Equal(expected, ActivationFileParser.Parse(Json(o)).Error);
    }

    [Theory]
    [InlineData("fdba1_" + "A" + "B")]
    [InlineData("FDBA1_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA")]
    [InlineData("fdba2_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA")]
    [InlineData("fdba1_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA+")]
    [InlineData("fdba1_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA")]
    public void The_ticket_pattern_is_exact(string ticket)
    {
        var o = Valid();
        o["ticket"] = ticket;
        Assert.Equal(ActivationParseError.BadTicket, ActivationFileParser.Parse(Json(o)).Error);
    }

    [Fact]
    public void Missing_ticket_or_version_is_refused()
    {
        var o = Valid();
        o.Remove("ticket");
        Assert.Equal(ActivationParseError.BadTicket, ActivationFileParser.Parse(Json(o)).Error);
        o = Valid();
        o.Remove("v");
        Assert.Equal(ActivationParseError.UnsupportedVersion, ActivationFileParser.Parse(Json(o)).Error);
    }

    [Fact]
    public void Unknown_extra_fields_are_tolerated_but_known_fields_may_not_repeat()
    {
        // Decision: forward compatible inside v1. Extra top-level fields (any JSON type) are ignored; the known ones are strict.
        var o = Valid();
        o["futureField"] = new { nested = 1 };
        o["note"] = "hello";
        Assert.True(ActivationFileParser.Parse(Json(o)).Ok);

        var duplicated = Encoding.UTF8.GetBytes($"{{\"format\":\"foreverdb-activation\",\"v\":1,\"ticket\":\"{Ticket}\",\"ticket\":\"{Ticket}\"}}");
        Assert.Equal(ActivationParseError.BadField, ActivationFileParser.Parse(duplicated).Error);
    }

    [Theory]
    [InlineData("")]
    [InlineData("not json")]
    [InlineData("[]")]
    [InlineData("\"fdba1_x\"")]
    [InlineData("{\"format\":\"foreverdb-activation\",}")]
    [InlineData("{/*c*/\"format\":\"foreverdb-activation\"}")]
    public void Non_objects_and_malformed_json_are_refused(string text)
    {
        Assert.False(ActivationFileParser.Parse(Encoding.UTF8.GetBytes(text)).Ok);
    }

    [Fact]
    public void A_utf8_byte_order_mark_is_tolerated_and_deep_nesting_is_refused()
    {
        var bom = new byte[] { 0xEF, 0xBB, 0xBF }.Concat(Json(Valid())).ToArray();
        Assert.True(ActivationFileParser.Parse(bom).Ok);

        var deep = Encoding.UTF8.GetBytes($"{{\"format\":\"foreverdb-activation\",\"v\":1,\"ticket\":\"{Ticket}\",\"x\":[[[[[[1]]]]]]}}");
        Assert.False(ActivationFileParser.Parse(deep).Ok);
    }

    [Fact]
    public void Ticket_and_candidate_never_print_the_ticket()
    {
        var parsed = ActivationFileParser.Parse(Json(Valid()));
        Assert.DoesNotContain("fdba1_", parsed.Ticket!.ToString());
        Assert.DoesNotContain("fdba1_", parsed.ToString()!);

        var dir = TestEnv.NewDirectory();
        File.WriteAllBytes(Path.Combine(dir, "a.fdbact"), Json(Valid()));
        var candidate = new FileActivationSource(new[] { new ActivationSearchLocation(dir, "*.fdbact") }).Discover().Single();
        Assert.DoesNotContain("fdba1_", candidate.ToString());
        Assert.DoesNotContain("a.fdbact", candidate.ToString());
    }

    // ---- discovery ----------------------------------------------------------------------------

    private static string Put(string dir, string name, object? content = null, DateTime? writtenAt = null)
    {
        Directory.CreateDirectory(dir);
        var path = Path.Combine(dir, name);
        File.WriteAllBytes(path, Json(content ?? Valid()));
        if (writtenAt is { } t) File.SetLastWriteTimeUtc(path, t);
        return path;
    }

    private static Dictionary<string, object> WithTicket(char c)
    {
        var o = Valid();
        o["ticket"] = "fdba1_" + new string(c, 43);
        return o;
    }

    [Fact]
    public void Discovery_follows_the_location_order_and_returns_the_newest_valid_file_first()
    {
        var root = TestEnv.NewDirectory();
        var appData = Path.Combine(root, "appdata");
        var install = Path.Combine(root, "install");
        var downloads = Path.Combine(root, "downloads");
        Put(downloads, "foreverdb-activation (1).fdbact", WithTicket('D'));
        Put(install, "any.fdbact", WithTicket('C'));
        Put(appData, "old.fdbact", WithTicket('A'), DateTime.UtcNow.AddHours(-2));
        Put(appData, "new.fdbact", WithTicket('B'), DateTime.UtcNow.AddHours(-1));

        var source = new FileActivationSource(new[]
        {
            new ActivationSearchLocation(appData, "*.fdbact"),
            new ActivationSearchLocation(install, "*.fdbact"),
            new ActivationSearchLocation(downloads, "foreverdb-activation*.fdbact", "foreverdb-activation")
        });

        var hashes = source.Discover().Select(c => c.Ticket.Hash).ToArray();
        string H(char c) => ActivationFileParser.Parse(Json(WithTicket(c))).Ticket!.Hash;
        Assert.Equal(new[] { H('B'), H('A'), H('C'), H('D') }, hashes);
    }

    [Fact]
    public void Downloads_only_accepts_the_activation_name_pattern()
    {
        var downloads = TestEnv.NewDirectory();
        Put(downloads, "holiday-plans.fdbact");
        Put(downloads, "notes.json");
        Put(downloads, "foreverdb-activation.fdbact.txt");
        Put(downloads, "foreverdb-activation.fdbactx");
        Assert.Empty(new FileActivationSource(new[] { new ActivationSearchLocation(downloads, "foreverdb-activation*.fdbact", "foreverdb-activation") }).Discover());

        Put(downloads, "foreverdb-activation.fdbact");
        Put(downloads, "foreverdb-activation (2).fdbact", WithTicket('E'));
        Assert.Equal(2, new FileActivationSource(new[] { new ActivationSearchLocation(downloads, "foreverdb-activation*.fdbact", "foreverdb-activation") }).Discover().Count);
    }

    [Fact]
    public void Oversized_invalid_and_nested_files_are_ignored_and_discovery_never_recurses()
    {
        var dir = TestEnv.NewDirectory();
        var big = Valid();
        big["pad"] = new string('x', 2000);
        Put(dir, "big.fdbact", big);
        File.WriteAllText(Path.Combine(dir, "bad.fdbact"), "{ not json");
        Put(Path.Combine(dir, "sub", "deeper"), "nested.fdbact");
        Assert.Empty(new FileActivationSource(new[] { new ActivationSearchLocation(dir, "*.fdbact") }).Discover());
        Assert.Empty(new FileActivationSource(new[] { new ActivationSearchLocation(Path.Combine(dir, "does-not-exist"), "*.fdbact") }).Discover());
    }

    [Fact]
    public void Symbolic_links_are_not_followed()
    {
        var dir = TestEnv.NewDirectory();
        var target = Put(TestEnv.NewDirectory(), "target.fdbact");
        try
        {
            File.CreateSymbolicLink(Path.Combine(dir, "link.fdbact"), target);
        }
        catch (Exception ex) when (ex is UnauthorizedAccessException or IOException or PlatformNotSupportedException)
        {
            return; // Windows without the symlink privilege: nothing to assert.
        }

        Assert.Empty(new FileActivationSource(new[] { new ActivationSearchLocation(dir, "*.fdbact") }).Discover());
    }

    [Fact]
    public void Remove_deletes_every_copy_of_the_ticket_and_only_those()
    {
        var root = TestEnv.NewDirectory();
        var a = Put(Path.Combine(root, "one"), "a.fdbact", WithTicket('A'));
        var copy = Put(Path.Combine(root, "two"), "foreverdb-activation (1).fdbact", WithTicket('A'));
        var other = Put(Path.Combine(root, "two"), "other.fdbact", WithTicket('B'));
        var source = new FileActivationSource(new[]
        {
            new ActivationSearchLocation(Path.Combine(root, "one"), "*.fdbact"),
            new ActivationSearchLocation(Path.Combine(root, "two"), "*.fdbact")
        });

        var found = source.Discover();
        Assert.True(source.Remove(found.First(c => c.Ticket.Hash == ActivationFileParser.Parse(Json(WithTicket('A'))).Ticket!.Hash).Ticket.Hash));
        Assert.False(File.Exists(a));
        Assert.False(File.Exists(copy));
        Assert.True(File.Exists(other));
    }

    [Fact]
    public void Default_locations_are_localappdata_activation_then_install_dir_then_downloads_with_the_pattern()
    {
        var root = TestEnv.NewDirectory();
        var install = TestEnv.NewDirectory();
        Put(Path.Combine(root, "activation"), "x.fdbact", WithTicket('L'));
        Put(install, "y.fdbact", WithTicket('I'));
        var source = FileActivationSource.CreateDefault(installDirectory: install, localAppDataDirectory: root);
        var found = source.Discover().Select(c => c.Ticket.Hash).ToArray();
        Assert.True(found.Length >= 2);
        Assert.Equal(ActivationFileParser.Parse(Json(WithTicket('L'))).Ticket!.Hash, found[0]);
        Assert.Equal(ActivationFileParser.Parse(Json(WithTicket('I'))).Ticket!.Hash, found[1]);
    }
}
