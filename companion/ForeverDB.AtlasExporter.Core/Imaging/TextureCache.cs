using ForeverDB.AtlasExporter.Client;

namespace ForeverDB.AtlasExporter.Imaging;

/// <summary>
/// Bounded LRU of decoded textures keyed by FileDataID, so tiles shared between
/// maps or art variants are read and decoded once, without retaining everything.
/// Negative results (missing/corrupt) are cached too: a broken tile is not
/// re-read for every map that references it.
/// </summary>
public sealed class TextureCache
{
    private readonly IAssetSource _assets;
    private readonly long _budgetBytes;
    private readonly Dictionary<int, LinkedListNode<Entry>> _index = new();
    private readonly LinkedList<Entry> _lru = new();
    private long _usedBytes;

    private sealed record Entry(int FileDataId, BgraImage? Image, string? Failure, long Size);

    public TextureCache(IAssetSource assets, long budgetBytes)
    {
        _assets = assets;
        _budgetBytes = Math.Max(budgetBytes, 1);
    }

    public int Hits { get; private set; }
    public int Misses { get; private set; }
    public long UsedBytes => _usedBytes;

    /// <returns>The texture, or null with <paramref name="failure"/> set.</returns>
    public BgraImage? Get(int fileDataId, out string? failure)
    {
        if (_index.TryGetValue(fileDataId, out var node))
        {
            Hits++;
            _lru.Remove(node);
            _lru.AddFirst(node);
            failure = node.Value.Failure;
            return node.Value.Image;
        }

        Misses++;
        BgraImage? image = null;
        failure = null;

        var bytes = _assets.ReadByFileDataId(fileDataId);

        if (bytes is null)
        {
            failure = $"FileDataID {fileDataId} not found in client storage";
        }
        else
        {
            try
            {
                image = BlpDecoder.Decode(bytes);
            }
            catch (TextureDecodeException ex)
            {
                failure = $"FileDataID {fileDataId} undecodable: {ex.Message}";
            }
        }

        var entry = new Entry(fileDataId, image, failure, image?.ByteSize ?? 64);
        _index[fileDataId] = _lru.AddFirst(entry);
        _usedBytes += entry.Size;

        while (_usedBytes > _budgetBytes && _lru.Count > 1)
        {
            var last = _lru.Last!;
            _lru.RemoveLast();
            _index.Remove(last.Value.FileDataId);
            _usedBytes -= last.Value.Size;
        }

        return image;
    }
}
