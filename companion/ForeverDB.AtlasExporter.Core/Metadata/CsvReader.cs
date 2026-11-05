using ForeverDB.AtlasExporter.Model;

namespace ForeverDB.AtlasExporter.Metadata;

/// <summary>Minimal RFC 4180 reader for DB2 CSV exports (header row = column names).</summary>
public static class CsvReader
{
    public static TableData Parse(string tableName, string text)
    {
        var records = ReadRecords(text);

        if (records.Count == 0)
        {
            throw new InvalidDataException($"{tableName}: CSV is empty.");
        }

        var header = records[0];
        var table = new TableData(tableName, header);

        for (var i = 1; i < records.Count; i++)
        {
            var fields = records[i];

            if (fields.Count == 1 && fields[0].Length == 0)
            {
                continue;
            }

            var row = new TableRow();

            for (var column = 0; column < header.Count && column < fields.Count; column++)
            {
                row.Set(header[column], fields[column]);
            }

            table.Rows.Add(row);
        }

        return table;
    }

    private static List<List<string>> ReadRecords(string text)
    {
        var records = new List<List<string>>();
        var fields = new List<string>();
        var field = new System.Text.StringBuilder();
        var quoted = false;

        for (var i = 0; i < text.Length; i++)
        {
            var c = text[i];

            if (quoted)
            {
                if (c == '"')
                {
                    if (i + 1 < text.Length && text[i + 1] == '"')
                    {
                        field.Append('"');
                        i++;
                    }
                    else
                    {
                        quoted = false;
                    }
                }
                else
                {
                    field.Append(c);
                }

                continue;
            }

            switch (c)
            {
                case '"':
                    quoted = true;
                    break;
                case ',':
                    fields.Add(field.ToString());
                    field.Clear();
                    break;
                case '\r':
                    break;
                case '\n':
                    fields.Add(field.ToString());
                    field.Clear();
                    records.Add(fields);
                    fields = new List<string>();
                    break;
                default:
                    field.Append(c);
                    break;
            }
        }

        if (field.Length > 0 || fields.Count > 0)
        {
            fields.Add(field.ToString());
            records.Add(fields);
        }

        return records;
    }
}
