using Microsoft.UI.Xaml;
using Microsoft.UI.Xaml.Controls;
using Windows.Foundation;

namespace DevHQ_WinUISmokeTest;

/// <summary>
/// Lays children out left to right and wraps when the line runs out, the way
/// <c>flex-wrap</c> does on the web. WinUI ships no such panel, and the two
/// places the card needs one - the technology tags and the stat line - hold
/// items of different widths, so a uniform grid would stretch them all to the
/// widest one.
/// </summary>
public sealed partial class WrapPanel : Panel
{
    public static readonly DependencyProperty HorizontalSpacingProperty =
        DependencyProperty.Register(nameof(HorizontalSpacing), typeof(double), typeof(WrapPanel),
            new PropertyMetadata(0d, OnSpacingChanged));

    public static readonly DependencyProperty VerticalSpacingProperty =
        DependencyProperty.Register(nameof(VerticalSpacing), typeof(double), typeof(WrapPanel),
            new PropertyMetadata(0d, OnSpacingChanged));

    public double HorizontalSpacing
    {
        get => (double)GetValue(HorizontalSpacingProperty);
        set => SetValue(HorizontalSpacingProperty, value);
    }

    public double VerticalSpacing
    {
        get => (double)GetValue(VerticalSpacingProperty);
        set => SetValue(VerticalSpacingProperty, value);
    }

    private static void OnSpacingChanged(DependencyObject d, DependencyPropertyChangedEventArgs e) =>
        ((WrapPanel)d).InvalidateMeasure();

    protected override Size MeasureOverride(Size available)
    {
        var limit = double.IsInfinity(available.Width) ? double.MaxValue : available.Width;
        double lineWidth = 0, lineHeight = 0, width = 0, height = 0;

        foreach (var child in Children)
        {
            child.Measure(new Size(limit, double.PositiveInfinity));
            var size = child.DesiredSize;
            var advance = lineWidth == 0 ? size.Width : lineWidth + HorizontalSpacing + size.Width;

            if (advance > limit && lineWidth > 0)
            {
                width = Math.Max(width, lineWidth);
                height += lineHeight + VerticalSpacing;
                lineWidth = size.Width;
                lineHeight = size.Height;
            }
            else
            {
                lineWidth = advance;
                lineHeight = Math.Max(lineHeight, size.Height);
            }
        }

        width = Math.Max(width, lineWidth);
        height += lineHeight;
        return new Size(double.IsInfinity(available.Width) ? width : Math.Min(width, available.Width), height);
    }

    protected override Size ArrangeOverride(Size final)
    {
        double x = 0, y = 0, lineHeight = 0;

        foreach (var child in Children)
        {
            var size = child.DesiredSize;
            if (x > 0 && x + size.Width > final.Width)
            {
                x = 0;
                y += lineHeight + VerticalSpacing;
                lineHeight = 0;
            }

            child.Arrange(new Rect(x, y, size.Width, size.Height));
            x += size.Width + HorizontalSpacing;
            lineHeight = Math.Max(lineHeight, size.Height);
        }

        return final;
    }
}
