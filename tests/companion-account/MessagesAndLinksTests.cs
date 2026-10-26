using Xunit;

namespace ForeverDB.Companion.Account.Tests;

public class MessagesAndLinksTests
{
    private static void AllHaveText<T>(Func<T, string> describe, params T[] except) where T : struct, Enum
    {
        foreach (var value in Enum.GetValues<T>().Where(v => !except.Contains(v)))
        {
            var text = describe(value);
            Assert.False(string.IsNullOrWhiteSpace(text), $"{typeof(T).Name}.{value} has no message");
            Assert.DoesNotMatch(@"eyJ|sb_|FDB-|[0-9A-Fa-f]{32}|Exception|HTTP \d|[A-Za-z]:\\", text);   // fixed prose only
        }
    }

    [Fact]
    public void Every_outcome_has_fixed_user_text_free_of_secrets_and_internals()
    {
        AllHaveText<BlockReason>(AccountMessages.Describe, BlockReason.None);
        AllHaveText<InstallationOwnership>(AccountMessages.Describe);
        AllHaveText<SignInOutcome>(AccountMessages.Describe);
        AllHaveText<SignOutOutcome>(AccountMessages.Describe);
        AllHaveText<ForgetOutcome>(AccountMessages.Describe);
        AllHaveText<StartAnonymousOutcome>(AccountMessages.Describe);
        AllHaveText<ClaimStartOutcome>(AccountMessages.Describe);
        AllHaveText<LinkCheckOutcome>(AccountMessages.Describe);
    }

    [Fact]
    public void Every_state_and_fault_combination_renders_without_leaking()
    {
        foreach (var state in Enum.GetValues<SessionState>())
        {
            foreach (var fault in Enum.GetValues<SessionFault>())
            {
                var status = new AccountStatus(state, fault, "elara@example.test", true, fault, true, true, 3, true, true);
                var headline = AccountMessages.Headline(status, status.VerifiedEmail);
                var detail = AccountMessages.Detail(status);
                Assert.False(string.IsNullOrWhiteSpace(headline));
                Assert.DoesNotContain("eyJ", detail);
                Assert.DoesNotContain("Exception", detail);
                Assert.DoesNotContain("HTTP", detail);
            }
        }
    }

    [Fact]
    public void Reauth_and_lost_states_explain_that_no_anonymous_identity_was_created_or_replaced()
    {
        var reauth = AccountMessages.Detail(new AccountStatus(SessionState.ReauthRequired, SessionFault.AuthRejected, null, false, SessionFault.None, false, true, 1));
        Assert.Contains("No anonymous identity was created", reauth);
        var lost = AccountMessages.Detail(new AccountStatus(SessionState.AnonymousIdentityLost, SessionFault.AuthRejected, null, false, SessionFault.None, false, true, 1));
        Assert.Contains("Nothing was replaced automatically", lost);
    }

    [Theory]
    [InlineData("https://staging.example.test", "register", "https://staging.example.test/account/register")]
    [InlineData("https://staging.example.test/", "forgot-password", "https://staging.example.test/account/forgot-password")]
    [InlineData("http://localhost:3000", "register", "http://localhost:3000/account/register")]
    [InlineData("http://example.test", "register", null)]                       // plain http only on loopback
    [InlineData("https://staging.example.test/x", "register", null)]            // bare origin only
    [InlineData("https://staging.example.test?x=1", "register", null)]
    [InlineData("https://user:pw@staging.example.test", "register", null)]
    [InlineData("https://klxhikdlfwgxurdyexdi.supabase.co", "register", null)]  // never the production project
    [InlineData("https://staging.example.test", "link", null)]                  // /account/link is PR E, not offered
    [InlineData("https://staging.example.test", "../admin", null)]
    [InlineData("javascript:alert(1)", "register", null)]
    [InlineData("", "register", null)]
    public void Website_links_are_allow_listed_and_validated(string origin, string page, string? expected)
    {
        var uri = AccountWebLinks.Resolve(n => n == AccountWebLinks.WebUrlVariable ? origin : null, page);
        Assert.Equal(expected, uri?.AbsoluteUri.TrimEnd('/') is { } s && expected is not null ? s : null);
        Assert.Equal(expected is null, uri is null);
    }
}
