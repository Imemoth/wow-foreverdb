namespace Atlas.Exporter.Tests;

internal static class TestRegistry
{
    public static void RegisterAll()
    {
        ClientTests.Register();
        CliTests.Register();
        Db2Tests.Register();
        EnumerationTests.Register();
        ImagingTests.Register();
        PipelineTests.Register();
    }
}
