using ForeverDB.AtlasExporter.Client;
using ForeverDB.AtlasExporter.Db2;
using ForeverDB.AtlasExporter.Metadata;

namespace ForeverDB.AtlasExporter.Diagnostics;

public sealed record TableDiagnosticsInput(
    IAssetSource Assets,
    IAssetProbe? Probe,
    IDbdSource Definitions,
    Version? Build,
    string ClientVersion,
    string CacheDirectory,
    bool AllowNetwork);

/// <summary>
/// Answers "why can't this table be read?" for every map-related DB2: where it was (not) found and
/// the storage error, header facts, table/layout hash, definition match, encrypted sections, row
/// count and whether a same-build CSV export is available.
/// </summary>
public static class TableDiagnostics
{
    public static async Task<DiagnosticsDocument> RunAsync(
        TableDiagnosticsInput input, ForeverDB.AtlasExporter.Export.Sanitizer sanitizer, CancellationToken token)
    {
        var doc = new DiagnosticsDocument("ForeverDB Atlas Exporter - table diagnostics", sanitizer);
        doc.Line($"Client build: {input.ClientVersion}");
        doc.Line("Each table is looked up by name and by its known FileDataID; 'error' is the CascLib error code.");
        var tables = new List<object>();

        foreach (var (table, fileDataId) in KnownTables.FileDataIds.OrderBy(pair => pair.Key, StringComparer.Ordinal))
        {
            token.ThrowIfCancellationRequested();
            var name = $@"DBFilesClient\{table}.db2";
            var byName = input.Assets.ReadByName(name);
            var byId = byName is null ? input.Assets.ReadByFileDataId(fileDataId) : null;
            var bytes = byName ?? byId;
            var nameProbe = byName is null ? input.Probe?.ProbeName(name) : null;
            var idProbe = byId is null && byName is null ? input.Probe?.ProbeFileDataId(fileDataId) : null;

            doc.Heading(table);
            doc.Line($"  expected FileDataID {fileDataId}");

            var entry = new Dictionary<string, object?>
            {
                ["table"] = table,
                ["expectedFileDataId"] = fileDataId,
                ["located"] = bytes is null ? "no" : byName is not null ? "by-name" : "by-filedataid",
                ["byNameProbe"] = nameProbe,
                ["byFileDataIdProbe"] = idProbe
            };

            if (bytes is null)
            {
                doc.Line("  NOT FOUND in storage (name or FileDataID).");

                if (nameProbe is not null)
                {
                    doc.Line($"    by name:        {nameProbe.ErrorMeaning} (error {nameProbe.ErrorCode}, {nameProbe.Source})");
                }

                if (idProbe is not null)
                {
                    doc.Line($"    by FileDataID:  {idProbe.ErrorMeaning} (error {idProbe.ErrorCode}, {idProbe.Source})");
                }
            }
            else
            {
                doc.Line($"  found {(byName is not null ? "by name" : "by FileDataID")}, {bytes.Length:N0} bytes");
                entry["bytes"] = bytes.Length;

                try
                {
                    var file = Db2File.Parse(bytes);
                    var expectedHash = KnownTables.TableHashes.GetValueOrDefault(table);
                    entry["magic"] = file.Magic;
                    entry["tableHash"] = file.TableHash.ToString("X8");
                    entry["tableHashMatches"] = file.TableHash == expectedHash;
                    entry["layoutHash"] = file.LayoutHashHex;
                    entry["recordCount"] = file.RecordCount;
                    entry["sections"] = file.Sections;
                    doc.Line($"  {file.Magic}, layout {file.LayoutHashHex}, table hash {(file.TableHash == expectedHash ? "matches" : "DIFFERS")}, " +
                             $"{file.RecordCount} record(s) in {file.Sections.Count} section(s)");

                    foreach (var section in file.Sections.Where(s => s.Encrypted))
                    {
                        doc.Line($"  ENCRYPTED section (TACT key {section.TactKeyHash:X16}): {section.RecordCount} record(s) unreadable without that key");
                    }

                    var dbdText = await input.Definitions.GetAsync(table, token);
                    entry["definitionAvailable"] = dbdText is not null;

                    if (dbdText is null)
                    {
                        doc.Line("  no .dbd definition available (needs one network run or --dbd-dir)");
                    }
                    else
                    {
                        var layout = DbdFile.Parse(table, dbdText).Select(file.LayoutHashHex, input.Build);
                        entry["definitionMatchesLayout"] = layout is not null;

                        if (layout is null)
                        {
                            doc.Line("  the .dbd has NO layout for this file's hash/build - the column layout is unknown to the definitions");
                        }
                        else
                        {
                            try
                            {
                                var data = file.Read(table, layout);
                                entry["rowsRead"] = data.Rows.Count;
                                entry["warnings"] = file.Warnings;
                                doc.Line($"  decoded {data.Rows.Count} row(s) with a {layout.Fields.Count}-column definition");

                                foreach (var warning in file.Warnings)
                                {
                                    doc.Line("  warning: " + warning);
                                }
                            }
                            catch (Db2FormatException ex)
                            {
                                entry["readError"] = doc.Clean(ex.Message);
                                doc.Line("  decode FAILED: " + ex.Message);
                            }
                        }
                    }
                }
                catch (Db2FormatException ex)
                {
                    entry["parseError"] = doc.Clean(ex.Message);
                    entry["headerCandidates"] = Db2File.Describe(bytes);
                    doc.Line("  header parse FAILED: " + ex.Message);

                    foreach (var candidate in Db2File.Describe(bytes))
                    {
                        doc.Line($"    prefix {candidate.Prefix}: {candidate.Reason} (records {candidate.RecordCount}, fields {candidate.FieldCount}, " +
                                 $"recordSize {candidate.RecordSize}, sections {candidate.SectionCount}, storageInfo {candidate.StorageInfoSize})");
                    }
                }
            }

            if (input.AllowNetwork)
            {
                var wago = new WagoCsvTableSource(input.ClientVersion, input.CacheDirectory, allowNetwork: true);
                var csv = await wago.ReadAsync(table, token);
                entry["sameBuildCsv"] = csv.Data is not null ? $"available ({csv.Data.Rows.Count} rows)" : $"unavailable ({csv.Error})";
                doc.Line($"  same-build wago.tools CSV: {entry["sameBuildCsv"]}");
            }

            tables.Add(entry);
        }

        doc.Data("tables", tables);
        return doc;
    }
}
