using ForeverDB.AtlasExporter.Imaging;
using SkiaSharp;

namespace ForeverDB.AtlasExporter.Export;

/// <summary>Offline contact sheet: static HTML + thumbnails, no server, no internet.</summary>
public static class GalleryWriter
{
    public static void Write(
        string root, IReadOnlyList<GalleryEntry> entries, BuildIdentity identity, int thumbnailWidth)
    {
        var thumbs = Path.Combine(root, "gallery", "thumbs");
        Directory.CreateDirectory(thumbs);

        foreach (var entry in entries.Where(e => e.SourceImagePath is not null))
        {
            var source = Path.Combine(root, entry.SourceImagePath!.Replace('/', Path.DirectorySeparatorChar));
            var thumbPath = Path.Combine(thumbs, entry.ThumbFile!);

            if (!File.Exists(source))
            {
                entry.ThumbFile = null;
                continue;
            }

            if (File.Exists(thumbPath) && File.GetLastWriteTimeUtc(thumbPath) >= File.GetLastWriteTimeUtc(source))
            {
                continue;
            }

            try
            {
                var image = WebpCodec.TryDecode(File.ReadAllBytes(source));

                if (image is null)
                {
                    entry.ThumbFile = null;
                    continue;
                }

                var targetWidth = Math.Min(thumbnailWidth, image.Width);
                var targetHeight = Math.Max(1, (int)Math.Round(image.Height * (double)targetWidth / image.Width));
                var info = new SKImageInfo(image.Width, image.Height, SKColorType.Bgra8888, SKAlphaType.Unpremul);
                using var bitmap = new SKBitmap(info);
                System.Runtime.InteropServices.Marshal.Copy(image.Pixels, 0, bitmap.GetPixels(), image.Pixels.Length);
                using var resized = bitmap.Resize(
                    new SKImageInfo(targetWidth, targetHeight, SKColorType.Bgra8888, SKAlphaType.Unpremul),
                    SKFilterQuality.Medium);
                var small = new BgraImage(targetWidth, targetHeight, new byte[targetWidth * targetHeight * 4]);
                System.Runtime.InteropServices.Marshal.Copy(resized.GetPixels(), small.Pixels, 0, small.Pixels.Length);
                JsonOut.WriteAtomic(thumbPath, WebpCodec.Encode(small, new WebpSettings(75, false)));
            }
            catch (Exception ex) when (ex is IOException or ArgumentException or InvalidOperationException)
            {
                entry.ThumbFile = null;
            }
        }

        var data = JsonOut.Serialize(new
        {
            client = new { identity.Product, identity.Version, identity.BuildKey },
            maps = entries.OrderBy(e => e.UiMapId).ThenBy(e => e.Variant, StringComparer.Ordinal)
        });

        var html = Template
            .Replace("/*__DATA__*/null", data.Replace("</", "<\\/"))
            .Replace("__TITLE__", $"ForeverDB Atlas Export - {identity.Product} {identity.Version}");

        JsonOut.WriteAtomic(Path.Combine(root, "gallery", "index.html"), html);
    }

    private const string Template = """
<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>__TITLE__</title>
<style>
:root{color-scheme:light dark;--bg:#fff;--fg:#1b1b1f;--card:#f2f2f5;--line:#d6d6dd;--ok:#1a7f37;--bad:#c62828;--warn:#b26a00;--mute:#666}
@media (prefers-color-scheme:dark){:root{--bg:#15151a;--fg:#ececf1;--card:#202028;--line:#33333d;--ok:#4cc26a;--bad:#ff6b6b;--warn:#f0a73a;--mute:#9a9aa6}}
body{margin:0;background:var(--bg);color:var(--fg);font:14px system-ui,sans-serif}
header{position:sticky;top:0;background:var(--bg);border-bottom:1px solid var(--line);padding:10px 16px;z-index:2}
h1{font-size:16px;margin:0 0 8px}
.row{display:flex;gap:8px;flex-wrap:wrap;align-items:center}
input,select{background:var(--card);color:var(--fg);border:1px solid var(--line);padding:6px 8px;border-radius:6px}
main{display:grid;grid-template-columns:repeat(auto-fill,minmax(250px,1fr));gap:12px;padding:16px}
.card{background:var(--card);border:1px solid var(--line);border-radius:8px;padding:8px;display:flex;flex-direction:column;gap:6px}
.thumb{aspect-ratio:3/2;background:repeating-conic-gradient(#8883 0 25%,#0000 0 50%) 0 0/16px 16px;display:flex;align-items:center;justify-content:center;border-radius:4px;overflow:hidden}
.thumb img{max-width:100%;max-height:100%;display:block}
.name{font-weight:600}.meta{color:var(--mute);font-size:12px;line-height:1.5}
.s-exported,.s-reused,.s-shared-art{color:var(--ok)}.s-failed{color:var(--bad)}.s-partial,.s-no-image{color:var(--warn)}
a{color:inherit}
</style></head><body>
<header><h1>__TITLE__</h1>
<div class="row">
<input id="q" type="search" placeholder="Search name or uiMapID" aria-label="Search">
<select id="cat" aria-label="Category"><option value="">All categories</option></select>
<select id="st" aria-label="Status"><option value="">All statuses</option></select>
<span id="count" class="meta"></span></div></header>
<main id="grid"></main>
<script>
const DATA=/*__DATA__*/null;
const grid=document.getElementById('grid'),q=document.getElementById('q'),cat=document.getElementById('cat'),st=document.getElementById('st'),count=document.getElementById('count');
const uniq=k=>[...new Set(DATA.maps.map(m=>m[k]))].sort();
for(const c of uniq('category'))cat.add(new Option(c,c));
for(const s of uniq('status'))st.add(new Option(s,s));
function esc(s){return String(s).replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]))}
function render(){
 const t=q.value.trim().toLowerCase();
 const list=DATA.maps.filter(m=>(!cat.value||m.category===cat.value)&&(!st.value||m.status===st.value)&&(!t||m.name.toLowerCase().includes(t)||String(m.uiMapId)===t));
 count.textContent=list.length+' of '+DATA.maps.length+' entries';
 grid.innerHTML=list.map(m=>{
  const img=m.thumb?'<img loading="lazy" alt="'+esc(m.name)+'" src="thumbs/'+esc(m.thumb)+'">':'<span class="meta">no image</span>';
  const full=m.image?'<a href="../'+esc(m.image)+'">open full image</a>':'';
  return '<article class="card"><div class="thumb">'+img+'</div><div class="name">'+esc(m.name||'(unnamed)')+'</div>'
  +'<div class="meta">uiMapID '+m.uiMapId+' &middot; MapArtID '+(m.mapArtId||'-')+' &middot; '+esc(m.variant)+'<br>'
  +esc(m.category)+(m.instanceKind?' / '+esc(m.instanceKind):'')+' &middot; '+(m.width?m.width+'&times;'+m.height:'-')+'<br>'
  +'<span class="s-'+esc(m.status)+'">'+esc(m.status)+'</span> &middot; build '+esc(DATA.client.version)
  +(m.note?'<br>'+esc(m.note):'')+'<br>'+full+'</div></article>'}).join('');
}
for(const e of [q,cat,st])e.addEventListener('input',render);
render();
</script></body></html>
""";
}

public sealed class GalleryEntry
{
    public int UiMapId { get; init; }
    public string Name { get; init; } = "";
    public int MapArtId { get; init; }
    public string Variant { get; init; } = "";
    public string Category { get; init; } = "";
    public string? InstanceKind { get; init; }
    public string Status { get; init; } = "";
    public int Width { get; init; }
    public int Height { get; init; }
    public string? Image { get; init; }
    public string? Note { get; init; }
    [System.Text.Json.Serialization.JsonIgnore]
    public string? ThumbFile { get; set; }

    [System.Text.Json.Serialization.JsonIgnore]
    public string? SourceImagePath { get; init; }

    public string? Thumb => ThumbFile;
}
