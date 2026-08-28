using Microsoft.UI.Input;
using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Microsoft.UI.Xaml.Documents;
using Microsoft.UI.Xaml.Input;
using Microsoft.UI.Xaml.Media;

namespace DevHQ_WinUISmokeTest;

/// <summary>
/// The overview, filled with fixed sample projects. Nothing here talks to the
/// DevHQ backend: the page exists so the native look can be compared with the
/// web one side by side.
/// </summary>
public sealed partial class MainPage : Page
{
    private TextBox? _prompt;

    public MainPage()
    {
        InitializeComponent();
        Loaded += (_, _) => Fill();
        ActualThemeChanged += (_, _) => Fill();
    }

    /// <summary>Flips the whole page between the two palettes, so both can be
    /// judged without restarting under a different system theme.</summary>
    public void ToggleTheme()
    {
        Root.RequestedTheme = Root.ActualTheme == ElementTheme.Dark ? ElementTheme.Light : ElementTheme.Dark;
        RequestedTheme = Root.RequestedTheme;
    }

    /// <summary>The tag and stat colours are picked in code, so the sample has
    /// to be rebuilt whenever the palette underneath it changes.</summary>
    private void Fill()
    {
        Theme.Use(Root.ActualTheme);
        Cards.ItemsSource = SampleData.Projects();
        if (TermLines.Children.Count == 0) FillTerminal();
    }

    // ~~~~~ the terminal dock ~~~~~

    private void ToggleDock_Click(object sender, RoutedEventArgs e)
    {
        var opening = Dock.Visibility == Visibility.Collapsed;
        Dock.Visibility = opening ? Visibility.Visible : Visibility.Collapsed;
        if (opening) _prompt?.Focus(FocusState.Programmatic);
    }

    /// <summary>The dock is dragged taller by its grip, within reason.</summary>
    private void DockGrip_ManipulationDelta(object sender, ManipulationDeltaRoutedEventArgs e)
    {
        Dock.Height = Math.Clamp(Dock.Height - e.Delta.Translation.Y, 120, ActualHeight - 200);
    }

    private void DockGrip_PointerEntered(object sender, PointerRoutedEventArgs e)
    {
        DockGrip.Background = Theme.Brush("AccentBrush");
        ProtectedCursor = InputSystemCursor.Create(InputSystemCursorShape.SizeNorthSouth);
    }

    private void DockGrip_PointerExited(object sender, PointerRoutedEventArgs e)
    {
        DockGrip.Background = new SolidColorBrush(Microsoft.UI.Colors.Transparent);
        ProtectedCursor = InputSystemCursor.Create(InputSystemCursorShape.Arrow);
    }

    /// <summary>
    /// A canned `npm run dev`, coloured out of the scheme's own ansi palette,
    /// followed by a prompt that really does take typing. Nothing is running
    /// behind it: Enter echoes the line and says so.
    /// </summary>
    private void FillTerminal()
    {
        Line(("PS ", "TermGreen"), ("C:\\code\\devhq", "TermBlue"), ("> npm run dev", "TermFg"));
        Line();
        Line(("> devhq@0.12.0 dev", "TermDim"));
        Line(("> tauri dev", "TermDim"));
        Line();
        Line(("  VITE ", "TermBrightMagenta"), ("v5.4.10", "TermDim"), ("  ready in ", "TermFg"),
             ("412 ms", "TermBrightGreen"));
        Line();
        Line(("  \u279c  Local:   ", "TermCyan"), ("http://localhost:5173/", "TermBrightBlue"));
        Line(("  \u279c  Network: ", "TermCyan"), ("use --host to expose", "TermDim"));
        Line();
        Line(("   Compiling ", "TermBrightGreen"), ("devhq v0.1.0 (C:\\code\\devhq\\src-tauri)", "TermFg"));
        Line(("warning", "TermYellow"), (": unused variable: `pane`", "TermFg"));
        Line(("    Finished ", "TermBrightGreen"), ("dev profile in 8.42s", "TermFg"));
        Line();

        // The live line: a prompt drawn as text, and a real field after it.
        _prompt = new TextBox
        {
            Style = (Style)Application.Current.Resources["BareTextBox"],
            FontFamily = (FontFamily)Application.Current.Resources["MonoFont"],
            FontSize = 12.5,
            Foreground = Theme.Brush("TermFg"),
            Background = new SolidColorBrush(Microsoft.UI.Colors.Transparent),
            BorderThickness = new Thickness(0),
            Padding = new Thickness(0),
            MinHeight = 0,
            AcceptsReturn = false,
        };
        _prompt.KeyDown += Prompt_KeyDown;

        // A grid, not a stack: the field takes the rest of the line, so the
        // caret can be driven out to the right edge the way a shell's is.
        var line = new Grid { MinHeight = 17, ColumnSpacing = 6 };
        line.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto });
        line.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) });
        line.Children.Add(new TextBlock
        {
            Text = "PS C:\\code\\devhq>",
            FontFamily = (FontFamily)Application.Current.Resources["MonoFont"],
            FontSize = 12.5,
            LineHeight = 17,
            Foreground = Theme.Brush("TermGreen"),
            VerticalAlignment = VerticalAlignment.Center,
        });
        Grid.SetColumn(_prompt, 1);
        line.Children.Add(_prompt);
        TermLines.Children.Add(line);
    }

    private void Prompt_KeyDown(object sender, KeyRoutedEventArgs e)
    {
        if (e.Key != Windows.System.VirtualKey.Enter || _prompt is null) return;

        var typed = _prompt.Text;
        _prompt.Text = "";
        e.Handled = true;

        // The echoed line goes in above the prompt, which stays last.
        var at = TermLines.Children.Count - 1;
        TermLines.Children.Insert(at, Build(("PS ", "TermGreen"), ("C:\\code\\devhq", "TermBlue"),
            ("> " + typed, "TermFg")));
        if (typed.Trim().Length > 0)
        {
            TermLines.Children.Insert(at + 1, Build(
                ("no shell behind this window \u2014 it is a mock", "TermDim2")));
        }

        TermScroll.UpdateLayout();
        TermScroll.ChangeView(null, TermScroll.ScrollableHeight, null);
    }

    private void Line(params (string Text, string Brush)[] runs) => TermLines.Children.Add(Build(runs));

    private static TextBlock Build(params (string Text, string Brush)[] runs)
    {
        var block = new TextBlock
        {
            FontFamily = (FontFamily)Application.Current.Resources["MonoFont"],
            FontSize = 12.5,
            LineHeight = 17,
            MinHeight = 17,
            IsTextSelectionEnabled = true,
            Foreground = Theme.Brush("TermFg"),
        };
        foreach (var (text, brush) in runs)
            block.Inlines.Add(new Run { Text = text, Foreground = Theme.Brush(brush) });
        return block;
    }
}
