using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Input;
using System.Windows.Threading;
using ForeverDB.Companion.Account;
using ForeverDB.Companion.Services;

namespace ForeverDB.Companion;

// Account System V1: the ACCOUNT tab. All identity, ownership and claim rules live in
// ForeverDB.Companion.Account; this file only presents them. It never shows or stores tokens, passwords or
// raw server responses.
public partial class MainWindow
{
    private DispatcherTimer? _claimTimer;
    private DispatcherTimer? _clipboardTimer;
    private ClaimOffer? _shownOffer;
    private string? _clipboardCode;
    private bool _signInRequested;
    private bool _accountBusy;

    internal sealed class InstallationRow
    {
        public string InstallationId { get; init; } = "";
        public string OwnershipText { get; init; } = "";
        public string DetailText { get; init; } = "";
        public Visibility DetailVisibility { get; init; } = Visibility.Collapsed;
        public Visibility ClaimVisibility { get; init; } = Visibility.Collapsed;
        public Visibility CheckVisibility { get; init; } = Visibility.Collapsed;
        public Visibility ChooseAccountVisibility { get; init; } = Visibility.Collapsed;
        public Visibility ChooseAnonymousVisibility { get; init; } = Visibility.Collapsed;
    }

    private void AttachAccountHandlers(AccountRuntime account)
    {
        account.Sessions.StatusChanged += _ =>
            Dispatcher.BeginInvoke(new Action(RefreshAccountUi));

        account.Sync.InstallationChanged += _ =>
            Dispatcher.BeginInvoke(new Action(RefreshAccountUi));

        account.Sessions.IdentityChanged += _ =>
            Dispatcher.BeginInvoke(new Action(OnAccountIdentityChanged));
    }

    private async Task RunAccountBackgroundChecksAsync(
        AccountRuntime account)
    {
        try
        {
            var status = account.Sessions.Status;

            if (status.PendingRevocation)
            {
                await account.Sessions.RetryPendingRevocationAsync();
            }

            if (status.State == SessionState.Registered)
            {
                // Confirms the stored account with the server (GET /auth/v1/user) before it is used for anything.
                await account.Sessions.GetAccessTokenAsync(SlotRole.Primary);
            }
        }
        catch (Exception)
        {
            // Background checks must never disturb the UI; the status already carries the outcome.
        }
    }

    private void OnAccountIdentityChanged()
    {
        // Account-scoped views die with the identity: a displayed code and any message about the previous one.
        HideClaimCard();
        AccountMessageText.Visibility = Visibility.Collapsed;
        RefreshAccountUi();
    }

    private async Task<string> GetSearchTokenAsync(
        CancellationToken cancellationToken)
    {
        var account = _account;

        if (account is null)
        {
            throw new InvalidOperationException(
                "ForeverDB is not configured.");
        }

        var token = await account.Sessions.GetReadTokenAsync(
            cancellationToken);

        if (token.Ok)
        {
            return token.AccessToken;
        }

        throw new InvalidOperationException(
            token.StateAfter switch
            {
                SessionState.LoggedOut =>
                    "Choose a sign-in or anonymous mode on the Account tab to use ForeverDB.",
                SessionState.ReauthRequired =>
                    "Sign in again on the Account tab.",
                SessionState.AnonymousIdentityLost =>
                    "The anonymous identity is lost. See the Account tab.",
                _ =>
                    "ForeverDB could not be reached. Your sign-in was kept."
            });
    }

    private void RefreshAccountUi()
    {
        if (AccountHeadlineText is null)
        {
            return;
        }

        if (!Dispatcher.CheckAccess())
        {
            Dispatcher.BeginInvoke(new Action(RefreshAccountUi));
            return;
        }

        var account = _account;

        if (account is null)
        {
            AccountHeadlineText.Text = "Not available";
            AccountDetailText.Text =
                "Configure the WoW path and ForeverDB connection in Settings first.";
            AccountEnvironmentText.Text = "";
            AccountChoicePanel.Visibility = Visibility.Collapsed;
            AccountSignInPanel.Visibility = Visibility.Collapsed;
            AccountSignedInPanel.Visibility = Visibility.Collapsed;
            AccountLostPanel.Visibility = Visibility.Collapsed;
            AccountLegacyPanel.Visibility = Visibility.Collapsed;
            AccountPendingPanel.Visibility = Visibility.Collapsed;
            AccountInstallationsList.ItemsSource = null;
            AccountInstallationsEmptyText.Visibility = Visibility.Visible;
            return;
        }

        var status = account.Sessions.Status;
        var enabled = status.AccountsEnabled;

        AccountHeadlineText.Text =
            AccountMessages.Headline(
                status,
                status.VerifiedEmail);
        AccountDetailText.Text =
            AccountMessages.Detail(status);
        AccountEnvironmentText.Text =
            enabled
                ? $"Account features are enabled for the {account.Gate.Environment.ToString().ToLowerInvariant()} test project (not production)."
                : "Account features are off in this build. ForeverDB works anonymously, exactly like before.";

        var loggedOut = status.State == SessionState.LoggedOut;
        var lost = status.State == SessionState.AnonymousIdentityLost;
        var reauth = status.State == SessionState.ReauthRequired;
        var registered = status.State == SessionState.Registered;
        var anonymous =
            status.State is SessionState.Anonymous or SessionState.AnonymousClaiming;

        var showSignIn =
            enabled &&
            !registered &&
            (_signInRequested || reauth);

        AccountSignInPanel.Visibility =
            showSignIn
                ? Visibility.Visible
                : Visibility.Collapsed;

        AccountChoicePanel.Visibility =
            (loggedOut || lost || (anonymous && enabled)) && !showSignIn
                ? Visibility.Visible
                : Visibility.Collapsed;

        AccountShowSignInButton.IsEnabled = enabled;
        AccountShowSignInButton.ToolTip =
            enabled
                ? null
                : "Sign-in is not enabled in this build.";
        AccountShowSignInButton.Content =
            anonymous
                ? "Sign in to a ForeverDB account (keeps this identity)"
                : "Sign in to a ForeverDB account";
        AccountUseAnonymousButton.Visibility =
            loggedOut
                ? Visibility.Visible
                : Visibility.Collapsed;

        AccountSignedInPanel.Visibility =
            registered
                ? Visibility.Visible
                : Visibility.Collapsed;

        AccountLostPanel.Visibility =
            lost
                ? Visibility.Visible
                : Visibility.Collapsed;

        AccountLegacyPanel.Visibility =
            status.HasLegacyOwner && enabled
                ? Visibility.Visible
                : Visibility.Collapsed;
        AccountLegacyText.Text =
            status.LegacyFault == SessionFault.AuthRejected
                ? "This computer's original anonymous identity is no longer accepted by the server."
                : status.LegacyFault == SessionFault.LocalCredentialCorrupt
                    ? "This computer's original anonymous identity is damaged and cannot be read."
                    : "This computer's original anonymous identity is kept so installations it owns keep syncing.";

        AccountPendingPanel.Visibility =
            status.PendingRevocation
                ? Visibility.Visible
                : Visibility.Collapsed;

        AccountRegisterLinkButton.Visibility =
            AccountWebLinks.Resolve(
                name => Environment.GetEnvironmentVariable(name),
                "register") is null
                ? Visibility.Collapsed
                : Visibility.Visible;
        AccountForgotLinkButton.Visibility =
            AccountWebLinks.Resolve(
                name => Environment.GetEnvironmentVariable(name),
                "forgot-password") is null
                ? Visibility.Collapsed
                : Visibility.Visible;

        var rows = account.Sync.Installations
            .Select(
                record =>
                    BuildInstallationRow(
                        record,
                        status))
            .ToList();

        AccountInstallationsList.ItemsSource = rows;
        AccountInstallationsEmptyText.Visibility =
            rows.Count == 0
                ? Visibility.Visible
                : Visibility.Collapsed;

        var buttonsEnabled = !_accountBusy;
        AccountSignInButton.IsEnabled = buttonsEnabled;
        AccountSignOutButton.IsEnabled = buttonsEnabled;
    }

    private InstallationRow BuildInstallationRow(
        InstallationRecord record,
        AccountStatus status)
    {
        var enabled = status.AccountsEnabled;
        var ownership = record.Ownership;

        var detail =
            record.LastBlock != BlockReason.None
                ? AccountMessages.Describe(record.LastBlock)
                : record.LastSyncedAt is { } at
                    ? $"Last synced {at.ToLocalTime():g}"
                    : "";

        var ownershipText = enabled
            ? AccountMessages.Describe(ownership)
            : "Anonymous sync (account features off)";

        if (record.ClaimPending)
        {
            ownershipText += " · link code shown";
        }

        var anonymousOwned =
            ownership == InstallationOwnership.OwnedByAnonymousIdentity;
        var selection =
            ownership == InstallationOwnership.OwnerSelectionRequired;
        var anonymousAvailable =
            status.State is SessionState.Anonymous or SessionState.AnonymousClaiming ||
            (status.HasLegacyOwner && status.LegacyFault == SessionFault.None);

        return new InstallationRow
        {
            InstallationId = record.InstallationId,
            OwnershipText = ownershipText,
            DetailText = detail,
            DetailVisibility =
                detail.Length == 0
                    ? Visibility.Collapsed
                    : Visibility.Visible,
            ClaimVisibility =
                enabled && anonymousOwned
                    ? Visibility.Visible
                    : Visibility.Collapsed,
            CheckVisibility =
                enabled &&
                (record.ClaimPending ||
                 ownership == InstallationOwnership.Unchecked ||
                 ownership == InstallationOwnership.TransferredSignInRequired)
                    ? Visibility.Visible
                    : Visibility.Collapsed,
            ChooseAccountVisibility =
                enabled && selection && status.State == SessionState.Registered
                    ? Visibility.Visible
                    : Visibility.Collapsed,
            ChooseAnonymousVisibility =
                enabled && selection && anonymousAvailable
                    ? Visibility.Visible
                    : Visibility.Collapsed
        };
    }

    private void ShowAccountMessage(string text)
    {
        AccountMessageText.Text = text;
        AccountMessageText.Visibility =
            string.IsNullOrWhiteSpace(text)
                ? Visibility.Collapsed
                : Visibility.Visible;
    }

    private void SetAccountBusy(bool busy)
    {
        _accountBusy = busy;
        RefreshAccountUi();
    }

    private async Task ResyncAfterIdentityChangeAsync()
    {
        var service = _syncService;
        var watcher = _watcher;

        if (service is null ||
            string.IsNullOrWhiteSpace(_settings.WowRoot))
        {
            return;
        }

        try
        {
            var finder = watcher ??
                new WowSavedVariablesWatcher(
                    _settings.WowRoot,
                    (_, _) => Task.CompletedTask);

            foreach (var file in finder.FindExistingFiles())
            {
                await service.SyncFileAsync(
                    file,
                    trigger: SyncTrigger.Auto);
            }

            if (watcher is null)
            {
                finder.Dispose();
            }
        }
        catch (Exception ex)
        {
            RecordSyncError(ex.Message);
        }
    }

    // ---------------------------------------------------------------------------------------------
    // Session actions
    // ---------------------------------------------------------------------------------------------

    private void AccountShowSignIn_Click(
        object sender,
        RoutedEventArgs e)
    {
        _signInRequested = true;
        ShowAccountMessage("");
        RefreshAccountUi();
        AccountEmailBox.Focus();
    }

    private async void AccountUseAnonymous_Click(
        object sender,
        RoutedEventArgs e)
    {
        await StartAnonymousAsync();
    }

    private async void AccountReplaceAnonymous_Click(
        object sender,
        RoutedEventArgs e)
    {
        await StartAnonymousAsync();
    }

    private async Task StartAnonymousAsync()
    {
        var account = _account;

        if (account is null ||
            _accountBusy)
        {
            return;
        }

        SetAccountBusy(true);

        try
        {
            var outcome = await account.Sessions.StartAnonymousAsync(
                confirmReplaceLostIdentity: false);

            if (outcome == StartAnonymousOutcome.ConfirmationRequired)
            {
                var confirmed =
                    MessageBox.Show(
                        this,
                        "The anonymous identity that was on this computer is lost or unreadable. " +
                        "A new anonymous identity cannot sync installations that the old one owned. " +
                        "The old credential file is kept aside, not deleted.\n\n" +
                        "Start a new anonymous identity?",
                        "Start a new anonymous identity",
                        MessageBoxButton.YesNo,
                        MessageBoxImage.Warning,
                        MessageBoxResult.No) == MessageBoxResult.Yes;

                if (confirmed)
                {
                    outcome = await account.Sessions.StartAnonymousAsync(
                        confirmReplaceLostIdentity: true);
                }
            }

            ShowAccountMessage(
                AccountMessages.Describe(outcome));

            if (outcome is StartAnonymousOutcome.Created or StartAnonymousOutcome.RestoredLegacyIdentity)
            {
                _signInRequested = false;
                await ResyncAfterIdentityChangeAsync();
            }
        }
        finally
        {
            SetAccountBusy(false);
        }
    }

    private void AccountPasswordBox_KeyDown(
        object sender,
        KeyEventArgs e)
    {
        if (e.Key == Key.Enter)
        {
            AccountSignIn_Click(
                sender,
                new RoutedEventArgs());
        }
    }

    private static char[] ReadPassword(
        PasswordBox box)
    {
        using var secure = box.SecurePassword;
        var pointer = IntPtr.Zero;

        try
        {
            pointer = Marshal.SecureStringToGlobalAllocUnicode(secure);
            var chars = new char[secure.Length];
            Marshal.Copy(
                pointer,
                chars,
                0,
                chars.Length);
            return chars;
        }
        finally
        {
            if (pointer != IntPtr.Zero)
            {
                Marshal.ZeroFreeGlobalAllocUnicode(pointer);
            }
        }
    }

    private async void AccountSignIn_Click(
        object sender,
        RoutedEventArgs e)
    {
        var account = _account;

        if (account is null ||
            _accountBusy)
        {
            return;
        }

        var password = ReadPassword(AccountPasswordBox);
        AccountPasswordBox.Clear();
        SetAccountBusy(true);

        try
        {
            // The manager wipes `password` when it is done.
            var outcome = await account.Sessions.SignInRegisteredAsync(
                AccountEmailBox.Text,
                password);

            ShowAccountMessage(
                AccountMessages.Describe(outcome));

            if (outcome == SignInOutcome.Success)
            {
                _signInRequested = false;
                AccountEmailBox.Clear();
                await ResyncAfterIdentityChangeAsync();
            }
        }
        finally
        {
            Array.Clear(password);
            SetAccountBusy(false);
        }
    }

    private async void AccountSignOut_Click(
        object sender,
        RoutedEventArgs e)
    {
        var account = _account;

        if (account is null ||
            _accountBusy)
        {
            return;
        }

        SetAccountBusy(true);

        try
        {
            var outcome = await account.Sessions.SignOutRegisteredAsync();
            ShowAccountMessage(
                AccountMessages.Describe(outcome));
        }
        finally
        {
            SetAccountBusy(false);
        }
    }

    private async void AccountRetryRevocation_Click(
        object sender,
        RoutedEventArgs e)
    {
        var account = _account;

        if (account is null ||
            _accountBusy)
        {
            return;
        }

        SetAccountBusy(true);

        try
        {
            ShowAccountMessage(
                AccountMessages.Describe(
                    await account.Sessions.RetryPendingRevocationAsync()));
        }
        finally
        {
            SetAccountBusy(false);
        }
    }

    private async void AccountDiscardRevocation_Click(
        object sender,
        RoutedEventArgs e)
    {
        var account = _account;

        if (account is null)
        {
            return;
        }

        var confirmed =
            MessageBox.Show(
                this,
                "If you stop retrying, the previous session may stay active on the ForeverDB server " +
                "until it expires or you sign out on another device.\n\nStop retrying?",
                "Stop retrying sign-out",
                MessageBoxButton.YesNo,
                MessageBoxImage.Warning,
                MessageBoxResult.No) == MessageBoxResult.Yes;

        if (confirmed)
        {
            await account.Sessions.DiscardPendingRevocationAsync(
                confirmed: true);
            RefreshAccountUi();
        }
    }

    private async void AccountForgetLegacy_Click(
        object sender,
        RoutedEventArgs e)
    {
        var account = _account;

        if (account is null ||
            _accountBusy)
        {
            return;
        }

        var confirmed =
            MessageBox.Show(
                this,
                "Forgetting the anonymous identity ends its server session and removes it from this computer.\n\n" +
                "Installations that still belong to it and have NOT been linked to your account will " +
                "permanently lose remote synchronization. Local data is not deleted.\n\n" +
                "Forget the anonymous identity?",
                "Forget anonymous identity",
                MessageBoxButton.YesNo,
                MessageBoxImage.Warning,
                MessageBoxResult.No) == MessageBoxResult.Yes;

        if (!confirmed)
        {
            return;
        }

        SetAccountBusy(true);

        try
        {
            var outcome = await account.Sessions.ForgetLegacyOwnerAsync(
                confirmed: true,
                discardIfRevocationFails: false);

            if (outcome == ForgetOutcome.RevocationFailedKept)
            {
                var discard =
                    MessageBox.Show(
                        this,
                        "The server could not be reached, so the anonymous identity was kept.\n\n" +
                        "Discard it from this computer anyway? Its server session would not be revoked.",
                        "Forget anonymous identity",
                        MessageBoxButton.YesNo,
                        MessageBoxImage.Warning,
                        MessageBoxResult.No) == MessageBoxResult.Yes;

                if (discard)
                {
                    outcome = await account.Sessions.ForgetLegacyOwnerAsync(
                        confirmed: true,
                        discardIfRevocationFails: true);
                }
            }

            ShowAccountMessage(
                AccountMessages.Describe(outcome));
        }
        finally
        {
            SetAccountBusy(false);
        }
    }

    private void OpenAccountWebPage(
        string page)
    {
        var uri = AccountWebLinks.Resolve(
            name => Environment.GetEnvironmentVariable(name),
            page);

        if (uri is null)
        {
            return;
        }

        try
        {
            Process.Start(
                new ProcessStartInfo(uri.AbsoluteUri)
                {
                    UseShellExecute = true
                });
        }
        catch (Exception)
        {
            ShowAccountMessage("The browser could not be opened.");
        }
    }

    private void AccountRegisterLink_Click(
        object sender,
        RoutedEventArgs e) =>
        OpenAccountWebPage("register");

    private void AccountForgotLink_Click(
        object sender,
        RoutedEventArgs e) =>
        OpenAccountWebPage("forgot-password");

    // ---------------------------------------------------------------------------------------------
    // Installations: ownership choice, link status, claim code
    // ---------------------------------------------------------------------------------------------

    private static string? RowId(
        object sender) =>
        ((sender as FrameworkElement)?.DataContext as InstallationRow)
        ?.InstallationId;

    private async void InstallationChooseAccount_Click(
        object sender,
        RoutedEventArgs e) =>
        await ChooseOwnerAsync(
            RowId(sender),
            OwnerChoice.RegisteredAccount);

    private async void InstallationChooseAnonymous_Click(
        object sender,
        RoutedEventArgs e) =>
        await ChooseOwnerAsync(
            RowId(sender),
            OwnerChoice.AnonymousIdentity);

    private async Task ChooseOwnerAsync(
        string? installationId,
        OwnerChoice choice)
    {
        var account = _account;
        var service = _syncService;

        if (account is null ||
            service is null ||
            installationId is null)
        {
            return;
        }

        var confirmed =
            MessageBox.Show(
                this,
                choice == OwnerChoice.RegisteredAccount
                    ? "This installation has no confirmed owner yet. Syncing it now makes your ForeverDB account its owner."
                    : "This installation has no confirmed owner yet. Syncing it now makes this computer's anonymous identity its owner.",
                "Choose the installation owner",
                MessageBoxButton.OKCancel,
                MessageBoxImage.Question,
                MessageBoxResult.Cancel) == MessageBoxResult.OK;

        if (!confirmed)
        {
            return;
        }

        account.Sync.SelectOwner(
            installationId,
            choice);

        var file = service.FileFor(installationId);

        if (file is null)
        {
            return;
        }

        try
        {
            await service.SyncFileAsync(
                file,
                force: true,
                trigger: SyncTrigger.Manual);
        }
        catch (Exception ex)
        {
            RecordSyncError(ex.Message);
        }
    }

    private async void InstallationCheck_Click(
        object sender,
        RoutedEventArgs e)
    {
        var account = _account;
        var id = RowId(sender);

        if (account is null ||
            id is null ||
            _accountBusy)
        {
            return;
        }

        SetAccountBusy(true);
        var generation = account.Sessions.Generation;

        try
        {
            var outcome = await account.Claims.CheckLinkStatusAsync(
                id,
                CancellationToken.None);

            if (account.Sessions.Generation != generation ||
                _account != account)
            {
                return;
            }

            ShowAccountMessage(
                AccountMessages.Describe(outcome));

            if (account.Claims.OfferFor(id) is null &&
                _shownOffer?.InstallationId == id)
            {
                HideClaimCard();
            }
        }
        catch (Exception)
        {
            ShowAccountMessage("The status could not be checked right now.");
        }
        finally
        {
            SetAccountBusy(false);
        }
    }

    private async void InstallationClaim_Click(
        object sender,
        RoutedEventArgs e)
    {
        var account = _account;
        var id = RowId(sender);

        if (account is null ||
            id is null ||
            _accountBusy)
        {
            return;
        }

        var confirmed =
            MessageBox.Show(
                this,
                "A one-time link code will be shown. Anyone who gets the code while it is valid can move this " +
                "installation to their ForeverDB account. Show the code only when you are about to use it, and " +
                "keep it private.\n\nCreate a link code?",
                "Link installation to your account",
                MessageBoxButton.OKCancel,
                MessageBoxImage.Warning,
                MessageBoxResult.Cancel) == MessageBoxResult.OK;

        if (!confirmed)
        {
            return;
        }

        SetAccountBusy(true);
        var generation = account.Sessions.Generation;

        try
        {
            var result = await account.Claims.StartClaimAsync(
                id,
                CancellationToken.None);

            if (account.Sessions.Generation != generation ||
                _account != account)
            {
                result.Offer?.Dispose();
                return;
            }

            ShowAccountMessage(
                AccountMessages.Describe(result.Outcome));

            if (result.Offer is not null)
            {
                ShowClaimCard(result.Offer);
            }
        }
        catch (Exception)
        {
            ShowAccountMessage("The link code could not be requested right now. It is not retried automatically.");
        }
        finally
        {
            SetAccountBusy(false);
        }
    }

    private void ShowClaimCard(
        ClaimOffer offer)
    {
        _shownOffer = offer;
        AccountClaimInstallationText.Text = offer.InstallationId;
        AccountClaimCodeText.Text = offer.DisplayCode;
        AccountClaimCard.Visibility = Visibility.Visible;
        UpdateClaimCountdown();

        _claimTimer ??= new DispatcherTimer
        {
            Interval = TimeSpan.FromSeconds(1)
        };

        _claimTimer.Tick -= ClaimTimer_Tick;
        _claimTimer.Tick += ClaimTimer_Tick;
        _claimTimer.Start();
    }

    private void ClaimTimer_Tick(
        object? sender,
        EventArgs e) =>
        UpdateClaimCountdown();

    private void UpdateClaimCountdown()
    {
        var offer = _shownOffer;

        if (offer is null ||
            offer.IsDisposed)
        {
            HideClaimCard();
            return;
        }

        if (offer.IsExpired(TimeProvider.System))
        {
            _account?.Claims.Dismiss(offer.InstallationId);
            HideClaimCard();
            ShowAccountMessage("The link code expired. Request a new one if you still want to link.");
            return;
        }

        var left = offer.Remaining(TimeProvider.System);
        AccountClaimCountdownText.Text =
            $"Expires in {(int)left.TotalMinutes}:{left.Seconds:00} · single use";
    }

    private void HideClaimCard()
    {
        _claimTimer?.Stop();
        _shownOffer = null;
        AccountClaimCodeText.Text = "";
        AccountClaimCard.Visibility = Visibility.Collapsed;
    }

    private void AccountCopyClaim_Click(
        object sender,
        RoutedEventArgs e)
    {
        var offer = _shownOffer;

        if (offer is null ||
            offer.IsDisposed)
        {
            return;
        }

        try
        {
            Clipboard.SetText(offer.DisplayCode);
            _clipboardCode = offer.DisplayCode;
            ShowAccountMessage("Code copied. It is removed from the clipboard after two minutes.");

            _clipboardTimer?.Stop();
            _clipboardTimer = new DispatcherTimer
            {
                Interval = TimeSpan.FromMinutes(2)
            };
            _clipboardTimer.Tick += (_, _) =>
            {
                _clipboardTimer?.Stop();

                try
                {
                    if (Clipboard.ContainsText() &&
                        Clipboard.GetText() == _clipboardCode)
                    {
                        Clipboard.Clear();
                    }
                }
                catch (Exception)
                {
                    // The clipboard may be locked by another program; nothing else to do.
                }

                _clipboardCode = null;
            };
            _clipboardTimer.Start();
        }
        catch (Exception)
        {
            ShowAccountMessage("The clipboard is busy. Select the code and copy it manually.");
        }
    }

    private void AccountDismissClaim_Click(
        object sender,
        RoutedEventArgs e)
    {
        var offer = _shownOffer;

        if (offer is not null)
        {
            _account?.Claims.Dismiss(offer.InstallationId);
        }

        HideClaimCard();
    }
}
