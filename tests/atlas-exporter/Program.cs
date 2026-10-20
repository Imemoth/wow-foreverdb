using Atlas.Exporter.Tests;

TestRegistry.RegisterAll();
var filter = args.FirstOrDefault(a => !a.StartsWith('-'));
return await Harness.RunAsync(filter);
