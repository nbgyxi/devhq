using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Media;

namespace DevHQ_WinUISmokeTest;

/// <summary>A technology chip on a card: the name, its version, and the
/// colour its kind wears in the web app.</summary>
public sealed class TechTag
{
    public TechTag(string name, string version, string kind)
    {
        Name = name;
        Version = version;
        Kind = kind;
    }

    public string Name { get; }
    public string Version { get; }
    public string Kind { get; }
    public bool HasVersion => !string.IsNullOrEmpty(Version);

    public Brush Background => Theme.Brush(Kind switch
    {
        "lang" => "TagLangBg",
        "runtime" => "TagRuntimeBg",
        "framework" => "TagFrameworkBg",
        "ui" => "TagUiBg",
        "data" => "TagDataBg",
        "infra" => "TagInfraBg",
        _ => "TagPlainBg",
    });

    public Brush Foreground => Theme.Brush(Kind switch
    {
        "lang" => "TagLangFg",
        "runtime" => "TagRuntimeFg",
        "framework" => "TagFrameworkFg",
        "ui" => "TagUiFg",
        "data" => "TagDataFg",
        "infra" => "TagInfraFg",
        _ => "TagPlainFg",
    });
}

/// <summary>One line of the card's stat row: a glyph, a value, and the colour
/// that says whether it is worth looking at.</summary>
public sealed class Stat
{
    public Stat(string glyph, string text, string tone = "")
    {
        Glyph = glyph;
        Text = text;
        Tone = tone;
    }

    public string Glyph { get; }
    public string Text { get; }
    public string Tone { get; }

    public Brush Foreground => Theme.Brush(Tone switch
    {
        "amber" => "AmberBrush",
        "green" => "GreenBrush",
        "red" => "RedBrush",
        "accent" => "AccentBrush",
        _ => "Dim2Brush",
    });
}

public sealed class Project
{
    public string Name { get; init; } = "";
    public string Version { get; init; } = "";
    public string Description { get; init; } = "";
    public int RunningCount { get; init; }
    public int ChangedCount { get; init; }
    public string CommitHash { get; init; } = "";
    public string CommitSubject { get; init; } = "";
    public string CommitAge { get; init; } = "";
    public bool CanRun { get; init; } = true;
    public IList<TechTag> Tech { get; init; } = new List<TechTag>();
    public IList<Stat> Stats { get; init; } = new List<Stat>();

    public bool HasVersion => !string.IsNullOrEmpty(Version);
    public string VersionLabel => "v" + Version;
    public bool IsRunning => RunningCount > 0;
    public string RunningLabel => RunningCount + " proc";

    /// <summary>The stripe down the left edge of the card: green while
    /// something is running, amber while the tree is dirty, both when both.</summary>
    public Brush Stripe
    {
        get
        {
            var green = Theme.Color("GreenBrush");
            var amber = Theme.Color("AmberBrush");
            if (IsRunning && ChangedCount > 0)
            {
                var gradient = new LinearGradientBrush { StartPoint = new(0, 0), EndPoint = new(0, 1) };
                gradient.GradientStops.Add(new GradientStop { Color = green, Offset = 0.5 });
                gradient.GradientStops.Add(new GradientStop { Color = amber, Offset = 0.5 });
                return gradient;
            }
            if (IsRunning) return new SolidColorBrush(green);
            if (ChangedCount > 0) return new SolidColorBrush(amber);
            return new SolidColorBrush(Microsoft.UI.Colors.Transparent);
        }
    }
}

/// <summary>
/// Reads a brush out of Theme.xaml. A tag's colour depends on what kind of
/// technology it is, which XAML cannot express in a binding, so the palette is
/// looked up by hand - and it has to be the palette for the theme actually on
/// screen, which means going into the theme dictionary rather than through the
/// merged one.
/// </summary>
public static class Theme
{
    private static ResourceDictionary? _palette;

    public static void Use(ElementTheme theme)
    {
        var wanted = theme == ElementTheme.Light ? "Light" : "Default";
        foreach (var dictionary in Application.Current.Resources.MergedDictionaries)
        {
            if (dictionary.ThemeDictionaries.TryGetValue(wanted, out var value) &&
                value is ResourceDictionary palette)
            {
                _palette = palette;
                return;
            }
        }
        _palette = null;
    }

    public static Brush Brush(string key)
    {
        if (_palette is not null && _palette.TryGetValue(key, out var themed) && themed is Brush themedBrush)
            return themedBrush;
        if (Application.Current.Resources.TryGetValue(key, out var value) && value is Brush brush)
            return brush;
        return new SolidColorBrush(Microsoft.UI.Colors.Gray);
    }

    public static Windows.UI.Color Color(string key) =>
        Brush(key) is SolidColorBrush solid ? solid.Color : Microsoft.UI.Colors.Gray;
}

public static class SampleData
{
    // Glyphs are Segoe Fluent Icons: the same shapes the web app pulls from
    // Material Symbols, near enough to judge the layout by.
    public const string GlyphSearch = "";
    public const string GlyphRefresh = "";
    public const string GlyphFolder = "";
    public const string GlyphEdit = "";
    public const string GlyphPlay = "";
    public const string GlyphCode = "";
    public const string GlyphTerminal = "";
    public const string GlyphDownload = "";
    public const string GlyphChevron = "";
    public const string GlyphClear = "";
    public const string GlyphFilter = "";
    public const string GlyphCheck = "";
    public const string GlyphBranch = "";
    public const string GlyphHistory = "";
    public const string GlyphOverview = "";
    public const string GlyphProcesses = "";
    public const string GlyphSettings = "";
    public const string GlyphTheme = "";
    public const string GlyphAhead = "";
    public const string GlyphBehind = "";
    public const string GlyphPort = "";
    public const string GlyphCloud = "";
    public const string GlyphStash = "";

    public static List<Project> Projects() => new()
    {
        new Project
        {
            Name = "devhq",
            Version = "0.12.0",
            Description = "A Tauri + Rust desktop app that scans a folder of development projects and reports git status, running processes and detected tech at a glance.",
            RunningCount = 2,
            ChangedCount = 17,
            CommitHash = "77cc39e",
            CommitSubject = "Add analytics reporting for page views",
            CommitAge = "12m ago",
            Tech =
            {
                new TechTag("Rust", "1.83", "lang"),
                new TechTag("JavaScript", "", "lang"),
                new TechTag("Tauri", "2.1.1", "framework"),
                new TechTag("Vite", "5.4", "ui"),
                new TechTag("SQLite", "", "data"),
            },
            Stats =
            {
                new Stat(GlyphBranch, "main"),
                new Stat(GlyphEdit, "17 changed", "amber"),
                new Stat("", "2", "accent"),
                new Stat(GlyphPort, ":1420 :5173", "green"),
            },
        },
        new Project
        {
            Name = "showdown-tv",
            Version = "2.4.1",
            Description = "Live tournament overlay renderer with a websocket control surface.",
            RunningCount = 1,
            ChangedCount = 0,
            CommitHash = "a91f0c2",
            CommitSubject = "Fix bracket reflow on late entrants",
            CommitAge = "3h ago",
            Tech =
            {
                new TechTag("TypeScript", "5.6", "lang"),
                new TechTag("Node", "22.4", "runtime"),
                new TechTag("Svelte", "5.0", "framework"),
                new TechTag("Tailwind", "3.4", "ui"),
            },
            Stats =
            {
                new Stat(GlyphBranch, "main"),
                new Stat(GlyphCheck, "clean"),
                new Stat(GlyphPort, ":3000", "green"),
            },
        },
        new Project
        {
            Name = "invoice-service",
            Version = "1.9.3",
            Description = "Billing and invoice generation for the platform, with a scheduled export job.",
            RunningCount = 0,
            ChangedCount = 4,
            CommitHash = "5d2ba70",
            CommitSubject = "Round VAT to the nearest cent",
            CommitAge = "yesterday",
            Tech =
            {
                new TechTag("C#", "13", "lang"),
                new TechTag(".NET", "10.0", "runtime"),
                new TechTag("ASP.NET", "", "framework"),
                new TechTag("Postgres", "16", "data"),
                new TechTag("Docker", "", "infra"),
            },
            Stats =
            {
                new Stat(GlyphBranch, "feat/vat-rounding"),
                new Stat(GlyphEdit, "4 changed", "amber"),
                new Stat("", "3", "red"),
            },
        },
        new Project
        {
            Name = "scanner-core",
            Version = "0.4.0",
            Description = "The shared crate behind the project scan: git, process table and tech detection.",
            RunningCount = 0,
            ChangedCount = 0,
            CommitHash = "e0417ad",
            CommitSubject = "Skip node_modules earlier in the walk",
            CommitAge = "2d ago",
            CanRun = false,
            Tech =
            {
                new TechTag("Rust", "1.83", "lang"),
                new TechTag("Tokio", "1.40", "framework"),
            },
            Stats =
            {
                new Stat(GlyphBranch, "main"),
                new Stat(GlyphCheck, "clean"),
                new Stat("", "no remote"),
            },
        },
        new Project
        {
            Name = "marketing-site",
            Version = "3.0.0",
            Description = "The public site and docs, built statically and pushed to the CDN on merge.",
            RunningCount = 1,
            ChangedCount = 2,
            CommitHash = "bb73f19",
            CommitSubject = "New pricing page hero",
            CommitAge = "5h ago",
            Tech =
            {
                new TechTag("TypeScript", "5.5", "lang"),
                new TechTag("Node", "20.11", "runtime"),
                new TechTag("Astro", "4.16", "framework"),
                new TechTag("Tailwind", "", "ui"),
                new TechTag("Cloudflare", "", "infra"),
            },
            Stats =
            {
                new Stat(GlyphBranch, "main"),
                new Stat(GlyphEdit, "2 changed", "amber"),
                new Stat(GlyphPort, ":4321", "green"),
            },
        },
        new Project
        {
            Name = "telemetry-pipeline",
            Version = "0.8.7",
            Description = "Ingests events, batches them and writes parquet to cold storage.",
            RunningCount = 0,
            ChangedCount = 0,
            CommitHash = "27c5e8b",
            CommitSubject = "Back off retries exponentially",
            CommitAge = "4d ago",
            Tech =
            {
                new TechTag("Python", "3.12", "lang"),
                new TechTag("Polars", "1.9", "data"),
                new TechTag("Kubernetes", "", "infra"),
            },
            Stats =
            {
                new Stat(GlyphBranch, "main"),
                new Stat(GlyphCheck, "clean"),
                new Stat("", "1 stash"),
            },
        },
    };
}
