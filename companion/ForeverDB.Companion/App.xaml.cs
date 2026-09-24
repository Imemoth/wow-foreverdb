using System.Windows;
using ForeverDB.Companion.Services;

namespace ForeverDB.Companion;

public partial class App : System.Windows.Application
{
    private const string InstanceMutexName =
        @"Local\ForeverDB.Companion.SingleInstance";
    private const string ShowWindowEventName =
        @"Local\ForeverDB.Companion.ShowWindow";

    private System.Windows.Forms.NotifyIcon? _trayIcon;
    private MainWindow? _mainWindow;
    private Mutex? _instanceMutex;
    private EventWaitHandle? _showWindowEvent;
    private CancellationTokenSource? _instanceListenerCts;

    protected override void OnStartup(StartupEventArgs e)
    {
        base.OnStartup(e);

        _instanceMutex = new Mutex(
            initiallyOwned: true,
            InstanceMutexName,
            out var isFirstInstance);

        if (!isFirstInstance)
        {
            try
            {
                using var showEvent =
                    EventWaitHandle.OpenExisting(
                        ShowWindowEventName);

                showEvent.Set();
            }
            catch
            {
                // If the first instance is still starting,
                // exiting here is safer than creating a duplicate.
            }

            _instanceMutex.Dispose();
            _instanceMutex = null;
            Shutdown();
            return;
        }

        _showWindowEvent = new EventWaitHandle(
            false,
            EventResetMode.AutoReset,
            ShowWindowEventName);

        _instanceListenerCts =
            new CancellationTokenSource();

        StartInstanceListener(
            _instanceListenerCts.Token);

        _mainWindow = new MainWindow();

        _trayIcon = new System.Windows.Forms.NotifyIcon
        {
            Text = "ForeverDB Companion",
            Visible = true,
            Icon = System.Drawing.SystemIcons.Information
        };

        var menu =
            new System.Windows.Forms.ContextMenuStrip();

        menu.Items.Add(
            "Open ForeverDB",
            null,
            (_, _) => ShowMainWindow());

        menu.Items.Add(
            "Exit",
            null,
            (_, _) => ExitApplication());

        _trayIcon.ContextMenuStrip = menu;
        _trayIcon.DoubleClick +=
            (_, _) => ShowMainWindow();

        var settings = SettingsService.Load();

        var requestedMinimized =
            e.Args.Any(
                arg => string.Equals(
                    arg,
                    "--minimized",
                    StringComparison.OrdinalIgnoreCase));

        var startMinimized =
            requestedMinimized &&
            settings.LaunchWithWindows &&
            settings.StartMinimized;

        if (startMinimized)
        {
            // Showing once ensures Loaded/init runs even when
            // Windows starts the app directly into the tray.
            _mainWindow.Show();
            _mainWindow.Hide();
        }
        else
        {
            ShowMainWindow();
        }
    }

    private void StartInstanceListener(
        CancellationToken cancellationToken)
    {
        _ = Task.Run(
            () =>
            {
                while (!cancellationToken.IsCancellationRequested)
                {
                    if (_showWindowEvent?.WaitOne(500) == true)
                    {
                        Dispatcher.BeginInvoke(
                            ShowMainWindow);
                    }
                }
            },
            cancellationToken);
    }

    private void ShowMainWindow()
    {
        if (_mainWindow is null)
        {
            _mainWindow = new MainWindow();
        }

        _mainWindow.Show();

        if (_mainWindow.WindowState ==
            WindowState.Minimized)
        {
            _mainWindow.WindowState =
                WindowState.Normal;
        }

        _mainWindow.ShowInTaskbar = true;
        _mainWindow.Activate();
        _mainWindow.Topmost = true;
        _mainWindow.Topmost = false;
        _mainWindow.Focus();
    }

    private void ExitApplication()
    {
        _trayIcon?.Dispose();
        Shutdown();
    }

    protected override void OnExit(ExitEventArgs e)
    {
        _instanceListenerCts?.Cancel();
        _showWindowEvent?.Set();
        _showWindowEvent?.Dispose();
        _instanceListenerCts?.Dispose();

        try
        {
            _instanceMutex?.ReleaseMutex();
        }
        catch
        {
        }

        _instanceMutex?.Dispose();
        _trayIcon?.Dispose();

        base.OnExit(e);
    }
}
