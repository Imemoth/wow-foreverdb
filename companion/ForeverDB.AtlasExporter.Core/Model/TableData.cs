using System.Globalization;

namespace ForeverDB.AtlasExporter.Model;

/// <summary>
/// One DB2/CSV table as named columns. Array columns hold <c>object?[]</c>,
/// everything else is long, double or string. Both the binary DB2 reader and the
/// CSV reader produce this shape so the map database builder is source-agnostic.
/// </summary>
public sealed class TableData
{
    public TableData(string name, IReadOnlyList<string> columns)
    {
        Name = name;
        Columns = columns;
    }

    public string Name { get; }
    public IReadOnlyList<string> Columns { get; }
    public List<TableRow> Rows { get; } = new();
    public bool HasColumn(string column) =>
        Columns.Contains(column, StringComparer.OrdinalIgnoreCase);
}

public sealed class TableRow
{
    private readonly Dictionary<string, object?> _values =
        new(StringComparer.OrdinalIgnoreCase);

    public void Set(string column, object? value) => _values[column] = value;

    public bool Has(string column) => _values.ContainsKey(column);

    public long Int(string column, long fallback = 0)
    {
        if (!_values.TryGetValue(column, out var value))
        {
            return fallback;
        }

        return value switch
        {
            long l => l,
            int i => i,
            double d => (long)d,
            string s when long.TryParse(
                s, NumberStyles.Integer, CultureInfo.InvariantCulture, out var parsed) => parsed,
            _ => fallback
        };
    }

    public double Float(string column, double fallback = 0)
    {
        if (!_values.TryGetValue(column, out var value))
        {
            return fallback;
        }

        return value switch
        {
            double d => d,
            long l => l,
            int i => i,
            string s when double.TryParse(
                s, NumberStyles.Float, CultureInfo.InvariantCulture, out var parsed) => parsed,
            _ => fallback
        };
    }

    public string Str(string column) =>
        _values.TryGetValue(column, out var value)
            ? Convert.ToString(value, CultureInfo.InvariantCulture) ?? ""
            : "";

    /// <summary>
    /// Array element: native array column ("UiMin") or CSV-flattened ("UiMin_0").
    /// </summary>
    public double FloatAt(string column, int index, double fallback = 0)
    {
        if (_values.TryGetValue(column, out var value) &&
            value is object?[] array)
        {
            return index < array.Length
                ? Convert.ToDouble(array[index], CultureInfo.InvariantCulture)
                : fallback;
        }

        return Float($"{column}_{index}", fallback);
    }
}
