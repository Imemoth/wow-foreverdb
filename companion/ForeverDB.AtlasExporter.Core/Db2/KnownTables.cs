namespace ForeverDB.AtlasExporter.Db2;

/// <summary>
/// Stable identifiers of the map tables, taken from the WoWDBDefs manifest.json
/// (db2FileDataID / tableHash). Lets the exporter open a DB2 by FileDataID when CASC
/// cannot resolve its name, and reject a file that is not the table it claims to be.
/// </summary>
public static class KnownTables
{
    public static readonly IReadOnlyDictionary<string, int> FileDataIds =
        new Dictionary<string, int>(StringComparer.Ordinal)
        {
            ["Map"] = 1349477,
            ["UiMap"] = 1957206,
            ["UiMapArt"] = 1957202,
            ["UiMapArtStyleLayer"] = 1957208,
            ["UiMapArtTile"] = 1957210,
            ["UiMapAssignment"] = 1957219,
            ["UiMapLink"] = 2030690,
            ["UiMapXMapArt"] = 1957217,
            ["WorldMapOverlay"] = 1134579,
            ["WorldMapOverlayTile"] = 1957212
        };

    public static readonly IReadOnlyDictionary<string, uint> TableHashes =
        new Dictionary<string, uint>(StringComparer.Ordinal)
        {
            ["Map"] = 0xBD84CD62,
            ["UiMap"] = 0x89927BF7,
            ["UiMapArt"] = 0x05089A9C,
            ["UiMapArtStyleLayer"] = 0x382DB23A,
            ["UiMapArtTile"] = 0x9C7EC549,
            ["UiMapAssignment"] = 0x5153A338,
            ["UiMapLink"] = 0x5578EDE9,
            ["UiMapXMapArt"] = 0xADB3FC8C,
            ["WorldMapOverlay"] = 0x1D740E72,
            ["WorldMapOverlayTile"] = 0xAC599725
        };
}
