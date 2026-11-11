using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Input;
using System.Windows.Threading;
using ForeverDB.Companion.Account;
using ForeverDB.Companion.Services;

namespace ForeverDB.Companion;

// Account System V1: the ACCOUNT tab. Human account identity and private account controls live in
// ForeverDB.Companion.Account; this file only presents them. It never shows or stores tokens, passwords or
// raw server responses.
public partial class MainWindow
{
    private bool _signInRequested;
    private bool _accountBusy;

    private void AttachAccountHandlers(AccountRuntime account)
    {
        if (account.Device is { } device)
        {
            device.Context.StatusChanged += _ =>
                Dispatcher.BeginInvoke(new Action(RefreshDeviceUi));
        }

        account.Sessions.StatusChanged += _ =>
            Dispatcher.BeginInvoke(new Action(() =>
            {
                RefreshAccountUi();
                RefreshGuildbookUi();
            }));

        account.Sync.InstallationChanged += _ =>
            Dispatcher.BeginInvoke(new Action(RefreshAccountUi));

        account.Sessions.IdentityChanged += _ =>
        {
            // Drop scheduled file events immediately when the active identity changes. The account coordinator
            // cancels public work; this also prevents a queued watcher callback from being relabelled as new-account work.
            _watcher?.Dispose();
            _watcher = null;
            Dispatcher.BeginInvoke(new Action(OnAccountIdentityChanged));
        };
    }

    /// <summary>
    /// Zero-touch: runs only when the gate created a device runtime. Finds an activation file, enrolls, then classifies the device
    /// with the server. Background, never blocks the UI, and a failure only changes the Registered device line.
    /// </summary>
    private async Task RunDeviceBackgroundAsync(
        AccountRuntime account)
    {
        if (account.Device is not { } device)
        {
            return;
        }

        try
        {
            var state = await device.Enrollment.InitializeAsync();

            if (state.State == DeviceState.Registered)
            {
                await device.Sync.CheckStatusAsync();
            }
        }
        catch (Exception)
        {
            // The status line already carries the outcome; nothing here may disturb the UI.
        }
        finally
        {
            await Dispatcher.BeginInvoke(new Action(RefreshDeviceUi));
        }
    }

    private async void DeviceRetry_Click(
        object sender,
        RoutedEventArgs e)
    {
        if (_account is { } account)
        {
            await RunDeviceBackgroundAsync(account);
        }
    }

    private void RefreshDeviceUi()
    {
        if (DevicePanel is null)
        {
            return;
        }

        if (!Dispatcher.CheckAccess())
        {
            Dispatcher.BeginInvoke(new Action(RefreshDeviceUi));
            return;
        }

        // Nothing is shown unless a device runtime exists (gate open) and there is something to say.
        var device = _account?.Device;
        var status = device?.Status;

        if (device is null ||
            status is null ||
            status.State == DeviceState.Anonymous)
        {
            DevicePanel.Visibility = Visibility.Collapsed;
            return;
        }

        DevicePanel.Visibility = Visibility.Visible;
        DeviceHeadlineText.Text = AccountMessages.Headline(status.State);
        DeviceDetailText.Text = status.Message;
        DeviceRetryButton.Visibility =
            status.State == DeviceState.PendingActivation
                ? Visibility.Visible
                : Visibility.Collapsed;
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

    private async void OnAccountIdentityChanged()
    {
        // Account-scoped views die with the identity: a displayed code and any message about the previous one.
        AccountMessageText.Visibility = Visibility.Collapsed;
        RefreshAccountUi();
        RefreshGuildbookUi();
        await RefreshLocalStateAfterIdentityChangeAsync();
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
            return;
        }

        var status = account.Sessions.Status;
        var enabled = status.AccountsEnabled;

        RefreshDeviceUi();

        AccountHeadlineText.Text =
            AccountMessages.Headline(
                status,
                status.VerifiedEmail);
        AccountDetailText.Text =
            AccountMessages.Detail(status);
        var environmentDescription = AccountFeatureGate.DescribeEffectiveEnvironment(account.Gate, account.Endpoint);
        var privatePilot = account.Gate.Environment is AccountEnvironment.PrivatePilot or AccountEnvironment.PrivateClaimPilot;
        AccountEnvironmentText.Text = privatePilot
            ? $"{environmentDescription}. Private account pilot; public observation sync uses a separate technical identity."
            : $"{environmentDescription}. Public observation sync uses a separate technical identity.";

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
            loggedOut && !privatePilot
                ? Visibility.Visible
                : Visibility.Collapsed;

        AccountSignedInPanel.Visibility =
            registered || reauth
                ? Visibility.Visible
                : Visibility.Collapsed;
        AccountSwitchButton.Visibility =
            registered || reauth
                ? Visibility.Visible
                : Visibility.Collapsed;
        AccountReturnAnonymousButton.Visibility =
            status.HasLegacyOwner && status.LegacyFault == SessionFault.None && (registered || reauth)
                ? Visibility.Visible
                : Visibility.Collapsed;

        AccountLostPanel.Visibility =
            lost
                ? Visibility.Visible
                : Visibility.Collapsed;

        AccountLegacyPanel.Visibility =
            status.HasLegacyOwner && enabled && !privatePilot
                ? Visibility.Visible
                : Visibility.Collapsed;
        AccountLegacyText.Text =
            status.LegacyFault == SessionFault.AuthRejected
                ? "This computer's technical upload credential is no longer accepted by the server."
                : status.LegacyFault == SessionFault.LocalCredentialCorrupt
                    ? "This computer's technical upload credential is damaged and cannot be read."
                    : "This computer's technical upload credential is stored locally and protected by Windows.";

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

        var buttonsEnabled = !_accountBusy;
        AccountSignInButton.IsEnabled = buttonsEnabled;
        AccountSignOutButton.IsEnabled = buttonsEnabled;
        AccountSwitchButton.IsEnabled = buttonsEnabled;
        AccountReturnAnonymousButton.IsEnabled = buttonsEnabled;
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

    private async Task RefreshLocalStateAfterIdentityChangeAsync()
    {
        var service = _syncService;
        if (service is null || string.IsNullOrWhiteSpace(_settings.WowRoot))
        {
            return;
        }

        WowSavedVariablesWatcher? temporaryFinder = null;
        try
        {
            temporaryFinder = new WowSavedVariablesWatcher(_settings.WowRoot, (_, _) => Task.CompletedTask);
            var files = temporaryFinder.FindExistingFiles().ToArray();
            var discovered = service.DiscoverInstallations(files);

            // Identity changes may refresh inventory and restore encrypted local Guildbook data only. Keep this method
            // structurally separate from the snapshot upload API so account actions cannot become an upload path.
            if (_guildbookSync is not null)
            {
                var restored = await GuildbookStartupCoordinator.RestoreAsync(
                    _guildbookSync,
                    discovered);
                _guildbookImportDiagnostics = FormatGuildbookRestoreDiagnostics(restored);
            }
            RefreshGuildbookUi();
            RefreshAccountUi();
        }
        catch (Exception)
        {
            _guildbookImportDiagnostics = "Local restore failed. Check local Guildbook cache access, then retry.";
            RefreshGuildbookUi();
        }
        finally
        {
            temporaryFinder?.Dispose();
            StartWatcher();
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
            if (outcome is SignOutOutcome.Confirmed or SignOutOutcome.LocalOnlyRevocationPending)
            {
                RefreshAccountUi();
            }
        }
        finally
        {
            SetAccountBusy(false);
        }
    }

    private async void AccountSwitchAccount_Click(object sender, RoutedEventArgs e)
    {
        var account = _account;
        if (account is null || _accountBusy)
        {
            return;
        }

        SetAccountBusy(true);
        try
        {
            var outcome = await account.Sessions.SignOutRegisteredAsync();
            if (outcome is SignOutOutcome.Confirmed or SignOutOutcome.LocalOnlyRevocationPending)
            {
                _signInRequested = true;
                AccountEmailBox.Clear();
                AccountPasswordBox.Clear();
                ShowAccountMessage(outcome == SignOutOutcome.LocalOnlyRevocationPending
                    ? "Signed out locally. Server revocation is pending and will be retried; you can now sign in to another account."
                    : "Signed out. Sign in with the other account when ready.");
            }
            else
            {
                ShowAccountMessage(AccountMessages.Describe(outcome));
            }
        }
        finally
        {
            SetAccountBusy(false);
        }

        if (_signInRequested)
        {
            AccountEmailBox.Focus();
        }
    }

    private async void AccountReturnAnonymous_Click(object sender, RoutedEventArgs e)
    {
        var account = _account;
        if (account is null || _accountBusy)
        {
            return;
        }

        if (MessageBox.Show(
                this,
                "Sign out of this account and restore this computer's preserved anonymous identity? Its credentials and installation history will be kept.",
                "Return to anonymous mode",
                MessageBoxButton.YesNo,
                MessageBoxImage.Question,
                MessageBoxResult.No) != MessageBoxResult.Yes)
        {
            return;
        }

        SetAccountBusy(true);
        try
        {
            var signedOut = await account.Sessions.SignOutRegisteredAsync();
            if (signedOut is not (SignOutOutcome.Confirmed or SignOutOutcome.LocalOnlyRevocationPending))
            {
                ShowAccountMessage(AccountMessages.Describe(signedOut));
                return;
            }

            var restored = await account.Sessions.RestoreLegacyAnonymousAsync();
            ShowAccountMessage(restored == StartAnonymousOutcome.RestoredLegacyIdentity
                ? signedOut == SignOutOutcome.LocalOnlyRevocationPending
                    ? "Restored the preserved anonymous identity. Server revocation of the previous account session remains pending."
                    : "Restored the preserved anonymous identity."
                : AccountMessages.Describe(restored));

            if (restored == StartAnonymousOutcome.RestoredLegacyIdentity)
            {
                _signInRequested = false;
            }
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

}
