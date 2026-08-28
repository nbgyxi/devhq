using Microsoft.UI.Xaml;

namespace DevHQ_WinUISmokeTest;

/// <summary>
/// The application window: a title bar on bg1 and the overview beneath it.
/// </summary>
public sealed partial class MainWindow : Window
{
    public MainWindow()
    {
        InitializeComponent();

        AppWindow.Resize(new Windows.Graphics.SizeInt32(1280, 860));

        ExtendsContentIntoTitleBar = true;
        SetTitleBar(AppTitleBar);

        AppWindow.SetIcon("Assets/AppIcon.ico");

        RootFrame.Navigate(typeof(MainPage));
    }

    private void ThemeToggle_Click(object sender, RoutedEventArgs e)
    {
        // The whole shell flips, title bar included, so the two palettes can be
        // compared without restarting under a different system theme.
        Shell.RequestedTheme = Shell.ActualTheme == ElementTheme.Dark ? ElementTheme.Light : ElementTheme.Dark;
        (RootFrame.Content as MainPage)?.ToggleTheme();
    }
}
