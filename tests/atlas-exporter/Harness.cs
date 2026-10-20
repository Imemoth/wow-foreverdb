using System.Diagnostics;

namespace Atlas.Exporter.Tests;

/// <summary>Tiny console test runner, matching the repo's other tests/* projects (no framework).</summary>
internal static class Harness
{
    private static readonly List<(string Name, Func<Task> Body)> Tests = new();

    public static void Add(string name, Action body) =>
        Tests.Add((name, () => { body(); return Task.CompletedTask; }));

    public static void Add(string name, Func<Task> body) => Tests.Add((name, body));

    public static async Task<int> RunAsync(string? filter)
    {
        var passed = 0;
        var failed = new List<string>();

        foreach (var (name, body) in Tests)
        {
            if (filter is not null && !name.Contains(filter, StringComparison.OrdinalIgnoreCase))
            {
                continue;
            }

            var watch = Stopwatch.StartNew();

            try
            {
                await body();
                passed++;
                Console.WriteLine($"PASS  {name} ({watch.ElapsedMilliseconds} ms)");
            }
            catch (Exception ex)
            {
                failed.Add(name);
                Console.WriteLine($"FAIL  {name}\n      {ex.GetType().Name}: {ex.Message}");

                if (ex is not AssertException)
                {
                    Console.WriteLine(ex.StackTrace);
                }
            }
        }

        Console.WriteLine();
        Console.WriteLine($"{passed} passed, {failed.Count} failed");
        return failed.Count == 0 ? 0 : 1;
    }
}

internal sealed class AssertException : Exception
{
    public AssertException(string message) : base(message) { }
}

internal static class Assert
{
    public static void True(bool condition, string message = "expected true")
    {
        if (!condition)
        {
            throw new AssertException(message);
        }
    }

    public static void False(bool condition, string message = "expected false") => True(!condition, message);

    public static void Equal<T>(T expected, T actual, string? what = null)
    {
        if (!EqualityComparer<T>.Default.Equals(expected, actual))
        {
            throw new AssertException($"{what ?? "values"}: expected <{expected}> but was <{actual}>");
        }
    }

    public static void Throws<TException>(Action action) where TException : Exception
    {
        try
        {
            action();
        }
        catch (TException)
        {
            return;
        }

        throw new AssertException($"expected {typeof(TException).Name}");
    }

    public static void Null(object? value, string message = "expected null")
    {
        if (value is not null)
        {
            throw new AssertException(message);
        }
    }

    public static TException ThrowsReturn<TException>(Action action) where TException : Exception
    {
        try
        {
            action();
        }
        catch (TException ex)
        {
            return ex;
        }

        throw new AssertException($"expected {typeof(TException).Name}");
    }

    public static async Task ThrowsAsync<TException>(Func<Task> action) where TException : Exception
    {
        try
        {
            await action();
        }
        catch (TException)
        {
            return;
        }

        throw new AssertException($"expected {typeof(TException).Name}");
    }

    public static void Contains(string haystack, string needle)
    {
        if (!haystack.Contains(needle, StringComparison.Ordinal))
        {
            throw new AssertException($"expected text to contain '{needle}'");
        }
    }

    public static void DoesNotContain(string haystack, string needle)
    {
        if (haystack.Contains(needle, StringComparison.OrdinalIgnoreCase))
        {
            throw new AssertException($"text must not contain '{needle}'");
        }
    }
}

internal sealed class TempDir : IDisposable
{
    public TempDir()
    {
        Path = System.IO.Path.Combine(
            System.IO.Path.GetTempPath(), "fdb-atlas-test-" + Guid.NewGuid().ToString("N")[..10]);
        Directory.CreateDirectory(Path);
    }

    public string Path { get; }
    public string Combine(params string[] parts) => System.IO.Path.Combine(new[] { Path }.Concat(parts).ToArray());

    public void Dispose()
    {
        try
        {
            Directory.Delete(Path, recursive: true);
        }
        catch (IOException)
        {
        }
    }
}
