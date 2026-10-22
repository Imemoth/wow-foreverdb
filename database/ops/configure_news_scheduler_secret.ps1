$ErrorActionPreference = 'Stop'

# This helper intentionally contains no secret values. It prompts for the
# existing database-admin password through psql and for the collector secret
# through a masked PowerShell prompt. Do not replace the prompt with literals.
$collectorSecret = Read-Host 'Collector secret' -AsSecureString
$secretBstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($collectorSecret)

try {
    $env:AZERDEX_NEWS_SCHEDULER_SECRET = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($secretBstr)
    $sql = @'
\set ON_ERROR_STOP on
\getenv scheduler_secret AZERDEX_NEWS_SCHEDULER_SECRET
begin;
insert into private.azerdex_news_settings(key, value)
values
  ('news_collector_url', 'https://chcoypkjzxfznsqmmbrq.supabase.co/functions/v1/azerdex-news-collector'),
  ('news_collector_secret', :'scheduler_secret')
on conflict (key) do update
  set value = excluded.value, updated_at = now();
commit;
\q
'@

    $sql | & psql -X -W "host=db.chcoypkjzxfznsqmmbrq.supabase.co port=5432 dbname=postgres user=postgres sslmode=require"
    if ($LASTEXITCODE -ne 0) {
        throw "psql exited with code $LASTEXITCODE"
    }
}
finally {
    [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($secretBstr)
    Remove-Item Env:AZERDEX_NEWS_SCHEDULER_SECRET -ErrorAction SilentlyContinue
}
